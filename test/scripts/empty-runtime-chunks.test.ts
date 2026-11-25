import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build, type InlineConfig, type Rolldown } from "tsdown";
import { expect, it } from "vitest";
import { createEmptyRuntimeChunksPlugin } from "../../scripts/lib/empty-runtime-chunks.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function createBuildOptions(cwd: string): InlineConfig {
  return {
    config: false,
    cwd,
    outDir: "dist",
    dts: false,
    target: "node22",
    fixedExtension: false,
    outExtensions: () => ({ js: ".js" }),
    minify: { codegen: true, compress: false, mangle: { toplevel: false, keepNames: true } },
    sourcemap: "hidden",
    logLevel: "silent",
  };
}

function runNodeJsonProbe(cwd: string, source: string[]): unknown {
  const output = execFileSync(
    resolveTestNodeExecPath(),
    ["--input-type=module", "-e", source.join("\n")],
    { cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  return JSON.parse(output);
}

function mapAssetBytes(asset: Rolldown.OutputBundle[string] | undefined): Buffer {
  if (!asset || asset.type !== "asset") {
    throw new Error("Expected an emitted sourcemap asset");
  }
  return typeof asset.source === "string"
    ? Buffer.from(asset.source, "utf8")
    : Buffer.from(asset.source);
}

it.each([
  { reference: "bare", order: "before" },
  { reference: "star", order: "before" },
  { reference: "star", order: "after" },
  { reference: "namespace", order: "before" },
  { reference: "namespace", order: "after" },
  { reference: "external", order: "before" },
  { reference: "mixed", order: "before" },
])(
  "preserves async graph behavior with $reference references $order a bare import",
  async ({ reference, order }) => {
    const root = createTempDir("openclaw-empty-runtime-chunks-");
    const externalCollision = reference === "external" || reference === "mixed";
    const sources = {
      "package.json": '{"type":"module"}',
      "a.ts": "export function a() { return 42; }",
      "b.ts": "export function b() { return 7; }",
      "barrel.ts": 'export { a } from "./a.js"; export { b } from "./b.js";',
      "consumer.ts": 'import { a, b } from "./barrel.js"; export const value = a() + b();',
      "other.ts": 'import { a } from "./a.js"; export const value = a();',
      "async.ts": [
        'import { b } from "./b.js";',
        'import "./effect.js";',
        "await Promise.resolve();",
        "export const value = b();",
        'export const load = () => import("./lazy.js");',
      ].join("\n"),
      "effect.ts": 'globalThis[Symbol.for("empty-chunk-effect")] = 1;',
      "empty.ts": "export {};",
      "lazy.ts": "export {};",
      ...(externalCollision ? { "collision.ts": "export const collision = true;" } : {}),
    };
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(root, name), source);
    }
    const emptyFiles: Array<{ fileName: string; map: unknown; mapFileName: string | null }> = [];
    const beforeCleanup: Array<{ fileName: string; code: string; imports: string[] }> = [];
    let observedFile = "";
    let retainedFile = "";
    let removedSpan: { start: number; end: number } | undefined;
    const { bundles } = await build({
      ...createBuildOptions(root),
      entry: {
        "sdk/barrel": "barrel.ts",
        "sdk/empty": "empty.ts",
        consumer: "consumer.ts",
        other: "other.ts",
        async: "async.ts",
        ...(externalCollision ? { collision: "collision.ts" } : {}),
      },
      outputOptions: { chunkFileNames: "[name]-🦊-[hash].mjs" },
      plugins: [
        {
          name: "observe-empty-companion-input",
          generateBundle(_options, bundle) {
            const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
            const candidates = chunks.filter(
              (chunk) =>
                !chunk.isEntry && !chunk.isDynamicEntry && chunk.code.trim() === "export{};",
            );
            expect(candidates.length).toBeGreaterThan(0);
            emptyFiles.push(
              ...candidates.map((chunk) => ({
                fileName: chunk.fileName,
                map: chunk.map,
                mapFileName: chunk.sourcemapFileName,
              })),
            );
            const target = candidates[0]!;
            const importer = chunks.find((chunk) => chunk.imports.includes(target.fileName));
            if (!importer) {
              throw new Error("The real graph did not emit an empty companion importer");
            }
            const statement = this.parse(importer.code).body.find(
              (node) =>
                node.type === "ImportDeclaration" &&
                node.specifiers.length === 0 &&
                path.posix.join(path.posix.dirname(importer.fileName), node.source.value) ===
                  target.fileName,
            );
            if (!statement || statement.type !== "ImportDeclaration") {
              throw new Error("The real graph did not emit a bare companion import");
            }
            const bareImport = importer.code.slice(statement.start, statement.end);
            expect(bareImport).toContain("🦊");
            if (externalCollision) {
              expect(path.posix.basename(target.fileName)).toBe(target.fileName);
              const collision = chunks.find((chunk) => chunk.fileName === "collision.js");
              if (!collision) {
                throw new Error("The real graph did not emit the collision entry");
              }
              const bare = `import ${JSON.stringify(target.fileName)};`;
              const relative = `import ${JSON.stringify(`./${target.fileName}`)};`;
              collision.code = bare + (reference === "mixed" ? relative : "") + collision.code;
              collision.imports =
                reference === "mixed" ? [target.fileName, target.fileName] : [target.fileName];
              const packageDir = path.join(root, "node_modules", target.fileName);
              fs.mkdirSync(packageDir, { recursive: true });
              fs.writeFileSync(
                path.join(packageDir, "package.json"),
                JSON.stringify({ type: "module", exports: "./index.js" }),
              );
              fs.writeFileSync(
                path.join(packageDir, "index.js"),
                'globalThis[Symbol.for("empty-chunk-external")] = (globalThis[Symbol.for("empty-chunk-external")] ?? 0) + 1;',
              );
              observedFile = collision.fileName;
              retainedFile = target.fileName;
            } else if (reference === "bare") {
              // Exercise JS line terminators and a literal astral specifier at the real AST boundary.
              const multilineImport = bareImport.replace(/^import/u, "import\r\n\u2028\u2029");
              importer.code =
                importer.code.slice(0, statement.start) +
                multilineImport +
                importer.code.slice(statement.end);
              removedSpan = {
                start: statement.start,
                end: statement.start + multilineImport.length,
              };
            } else {
              // A preceding plugin may add another syntax reference to an existing metadata edge.
              const exported = reference === "namespace" ? "* as emptyNamespace" : "*";
              const reexport = `export ${exported} from ${JSON.stringify(statement.source.value)};`;
              importer.code =
                importer.code.slice(0, statement.start) +
                (order === "before" ? reexport + bareImport : bareImport + reexport) +
                importer.code.slice(statement.end);
              if (reference === "namespace") {
                importer.exports = [...importer.exports, "emptyNamespace"];
              }
              retainedFile = target.fileName;
            }
            if (!externalCollision) {
              observedFile = importer.fileName;
            }
            beforeCleanup.push(
              ...chunks.map((chunk) => ({
                fileName: chunk.fileName,
                code: chunk.code,
                imports: [...chunk.imports],
              })),
            );
          },
        },
        createEmptyRuntimeChunksPlugin(),
      ],
    });
    try {
      const chunks = bundles
        .flatMap((bundle) => bundle.chunks)
        .filter((chunk) => chunk.type === "chunk");
      expect(emptyFiles.length).toBeGreaterThan(0);
      for (const { fileName, map, mapFileName } of emptyFiles) {
        const kept = fileName === retainedFile;
        expect(chunks.some((chunk) => chunk.fileName === fileName)).toBe(kept);
        expect(fs.existsSync(path.join(root, "dist", fileName))).toBe(kept);
        // Empty generated companions have no mapped source, even with hidden sourcemaps.
        expect(map).toBeNull();
        expect(mapFileName).toBeNull();
      }
      const observed = chunks.find((chunk) => chunk.fileName === observedFile)!;
      const original = beforeCleanup.find((chunk) => chunk.fileName === observedFile)!;
      if (removedSpan) {
        expect(observed.code.length).toBe(original.code.length);
        expect(observed.code.slice(0, removedSpan.start)).toBe(
          original.code.slice(0, removedSpan.start),
        );
        expect(observed.code.slice(removedSpan.end)).toBe(original.code.slice(removedSpan.end));
        for (let index = removedSpan.start; index < removedSpan.end; index++) {
          const character = original.code.charAt(index);
          expect(observed.code[index]).toBe(
            ["\r", "\n", "\u2028", "\u2029"].includes(character) ? character : " ",
          );
        }
        for (const before of beforeCleanup) {
          const after = chunks.find((chunk) => chunk.fileName === before.fileName);
          if (after) {
            expect(after.imports).toEqual(
              before.imports.filter(
                (dependency) => !emptyFiles.some((file) => file.fileName === dependency),
              ),
            );
          }
        }
      } else {
        expect(observed.code).toBe(original.code);
        expect(observed.imports).toEqual(original.imports);
        expect(observed.imports).toContain(retainedFile);
        if (externalCollision) {
          for (const before of beforeCleanup.filter((chunk) =>
            chunk.imports.includes(retainedFile),
          )) {
            expect(chunks.find((chunk) => chunk.fileName === before.fileName)?.imports).toContain(
              retainedFile,
            );
          }
        }
      }
      const result = runNodeJsonProbe(root, [
        'import * as api from "./dist/sdk/barrel.js";',
        'import * as empty from "./dist/sdk/empty.js";',
        'import { value, load } from "./dist/async.js";',
        `const observed = await import(${JSON.stringify(`./dist/${observedFile}`)});`,
        "console.log(JSON.stringify({",
        "keys: Object.keys(api), values: [api.a(), api.b(), value],",
        "empty: Object.keys(empty), lazy: Object.keys(await load()),",
        'effect: globalThis[Symbol.for("empty-chunk-effect")],',
        'externalEffect: globalThis[Symbol.for("empty-chunk-external")] ?? null,',
        "namespace: observed.emptyNamespace ? Object.keys(observed.emptyNamespace) : null",
        "}));",
      ]);
      expect(result).toEqual({
        keys:
          reference === "namespace" && observedFile === "sdk/barrel.js"
            ? ["a", "b", "emptyNamespace"]
            : ["a", "b"],
        values: [42, 7, 7],
        empty: [],
        lazy: [],
        effect: 1,
        externalEffect: externalCollision ? 1 : null,
        namespace: reference === "namespace" ? [] : null,
      });
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);

it("removes an elided chunk's real sourcemap while preserving mapped entry positions", async () => {
  const root = createTempDir("openclaw-empty-runtime-map-");
  for (const [name, source] of Object.entries({
    "package.json": '{"type":"module"}',
    "left.ts": 'import "./shared.js"; export const left = 41;',
    "right.ts": 'import "./shared.js"; export const right = 1;',
    "shared.ts": 'globalThis[Symbol.for("elided-shared-effect")] = true;',
  })) {
    fs.writeFileSync(path.join(root, name), source);
  }
  let removedFile = "";
  let removedMap = "";
  const entries: Array<{
    fileName: string;
    code: string;
    imports: string[];
    spans: Array<{ start: number; end: number }>;
    map: string;
    mapFileName: string;
    mapBytes: Buffer;
  }> = [];
  const { bundles } = await build({
    ...createBuildOptions(root),
    entry: { left: "left.ts", right: "right.ts" },
    plugins: [
      {
        name: "elide-real-shared-chunk",
        generateBundle(_options, bundle) {
          const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
          const sharedChunks = chunks.filter((chunk) => !chunk.isEntry && !chunk.isDynamicEntry);
          expect(sharedChunks).toHaveLength(1);
          const shared = sharedChunks[0];
          if (!shared) {
            throw new Error("Expected a real shared non-entry chunk");
          }
          expect(shared.exports).toEqual([]);
          expect(shared.imports).toEqual([]);
          expect(shared.dynamicImports).toEqual([]);
          expect(shared.code.trim()).not.toBe("export{};");
          expect(shared.map).not.toBeNull();
          if (shared.sourcemapFileName === null) {
            throw new Error("Expected the shared chunk's real sourcemap filename");
          }
          removedFile = shared.fileName;
          removedMap = shared.sourcemapFileName;
          expect(mapAssetBytes(bundle[removedMap]).length).toBeGreaterThan(0);
          const entryChunks = chunks.filter((chunk) => chunk.isEntry);
          expect(entryChunks.map((entry) => entry.fileName).toSorted()).toEqual([
            "left.js",
            "right.js",
          ]);
          for (const entry of entryChunks) {
            expect(entry.map).not.toBeNull();
            if (entry.sourcemapFileName === null) {
              throw new Error("Expected a mapped entry's sourcemap filename");
            }
            const mapBytes = mapAssetBytes(bundle[entry.sourcemapFileName]);
            const spans: Array<{ start: number; end: number }> = [];
            for (const node of this.parse(entry.code).body) {
              if (
                node.type === "ImportDeclaration" &&
                node.specifiers.length === 0 &&
                path.posix.join(path.posix.dirname(entry.fileName), node.source.value) ===
                  removedFile
              ) {
                spans.push({ start: node.start, end: node.end });
              }
            }
            expect(spans.length).toBeGreaterThan(0);
            entries.push({
              fileName: entry.fileName,
              code: entry.code,
              imports: [...entry.imports],
              spans,
              map: JSON.stringify(entry.map),
              mapFileName: entry.sourcemapFileName,
              mapBytes,
            });
          }
          expect(entries).toHaveLength(2);
          // Model an earlier plugin eliding code; retire its genuine map with that chunk.
          shared.code = "export{};";
        },
      },
      createEmptyRuntimeChunksPlugin(),
    ],
  });
  try {
    const output = bundles.flatMap((bundle) => bundle.chunks);
    for (const name of [removedFile, removedMap]) {
      expect(output.some((item) => item.fileName === name)).toBe(false);
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    for (const entry of entries) {
      const after = output.find((item) => item.fileName === entry.fileName);
      if (!after || after.type !== "chunk") {
        throw new Error("Expected the mapped entry to survive cleanup");
      }
      expect(JSON.stringify(after.map)).toBe(entry.map);
      expect(after.sourcemapFileName).toBe(entry.mapFileName);
      const asset = output.find((item) => item.fileName === entry.mapFileName);
      expect(mapAssetBytes(asset)).toEqual(entry.mapBytes);
      expect(fs.readFileSync(path.join(root, "dist", entry.mapFileName))).toEqual(entry.mapBytes);
      expect(after.imports).toEqual(entry.imports.filter((name) => name !== removedFile));
      expect(after.code.length).toBe(entry.code.length);
      for (let index = 0; index < entry.code.length; index++) {
        if (!entry.spans.some((span) => index >= span.start && index < span.end)) {
          expect(after.code.charAt(index)).toBe(entry.code.charAt(index));
        }
      }
    }
    const result = runNodeJsonProbe(root, [
      'import { left } from "./dist/left.js"; import { right } from "./dist/right.js"; console.log(JSON.stringify([left, right, globalThis[Symbol.for("elided-shared-effect")] ?? null]));',
    ]);
    expect(result).toEqual([41, 1, null]);
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});

it("leaves unaffected chunk imports untouched while removing an empty companion", () => {
  const generateBundle = createEmptyRuntimeChunksPlugin().generateBundle;
  if (typeof generateBundle !== "function") {
    throw new Error("Expected a callable empty-chunk cleanup hook");
  }
  const empty = {
    type: "chunk",
    fileName: "empty.mjs",
    code: "export{};",
    isEntry: false,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    exports: [],
  };
  const imports = ["external-package"];
  let assignments = 0;
  const entry = {
    ...empty,
    fileName: "entry.mjs",
    code: "export const value = 1;",
    isEntry: true,
    exports: ["value"],
    get imports() {
      return imports;
    },
    set imports(_value: string[]) {
      assignments++;
    },
  };
  const bundle = { "empty.mjs": empty, "entry.mjs": entry };
  Reflect.apply(generateBundle, {}, [{}, bundle, false]);
  expect(Object.keys(bundle)).toEqual(["entry.mjs"]);
  expect(assignments).toBe(0);
  expect(entry.imports).toBe(imports);
  expect(entry.code).toBe("export const value = 1;");
});
