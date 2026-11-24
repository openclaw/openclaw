import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import { createEmptyRuntimeChunksPlugin } from "../../scripts/lib/empty-runtime-chunks.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each([
  { reference: "bare", order: "before" },
  { reference: "star", order: "before" },
  { reference: "star", order: "after" },
  { reference: "namespace", order: "before" },
  { reference: "namespace", order: "after" },
])(
  "preserves async graph behavior with $reference references $order a bare import",
  async ({ reference, order }) => {
    const root = createTempDir("openclaw-empty-runtime-chunks-");
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
    };
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(root, name), source);
    }
    const emptyFiles: Array<{ fileName: string; map: string | null }> = [];
    const beforeCleanup: Array<{ fileName: string; code: string; imports: string[] }> = [];
    let observedFile = "";
    let retainedFile = "";
    let removedSpan: { start: number; end: number } | undefined;
    const { bundles } = await build({
      config: false,
      cwd: root,
      entry: {
        "sdk/barrel": "barrel.ts",
        "sdk/empty": "empty.ts",
        consumer: "consumer.ts",
        other: "other.ts",
        async: "async.ts",
      },
      outDir: "dist",
      dts: false,
      target: "node22",
      fixedExtension: false,
      outExtensions: () => ({ js: ".js" }),
      minify: { codegen: true, compress: false, mangle: { toplevel: false, keepNames: true } },
      sourcemap: "hidden",
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
                map: chunk.sourcemapFileName,
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
            if (reference === "bare") {
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
            observedFile = importer.fileName;
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
      logLevel: "silent",
    });
    try {
      const chunks = bundles.flatMap((bundle) => bundle.chunks);
      expect(emptyFiles.length).toBeGreaterThan(0);
      for (const { fileName, map } of emptyFiles) {
        const kept = fileName === retainedFile;
        expect(chunks.some((chunk) => chunk.fileName === fileName)).toBe(kept);
        expect(fs.existsSync(path.join(root, "dist", fileName))).toBe(kept);
        expect(map).not.toBeNull();
        expect(fs.existsSync(path.join(root, "dist", map!))).toBe(kept);
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
      }
      const result = execFileSync(
        resolveTestNodeExecPath(),
        [
          "--input-type=module",
          "-e",
          [
            'import * as api from "./dist/sdk/barrel.js";',
            'import * as empty from "./dist/sdk/empty.js";',
            'import { value, load } from "./dist/async.js";',
            `const observed = await import(${JSON.stringify(`./dist/${observedFile}`)});`,
            "console.log(JSON.stringify({",
            "keys: Object.keys(api), values: [api.a(), api.b(), value],",
            "empty: Object.keys(empty), lazy: Object.keys(await load()),",
            'effect: globalThis[Symbol.for("empty-chunk-effect")],',
            "namespace: observed.emptyNamespace ? Object.keys(observed.emptyNamespace) : null",
            "}));",
          ].join("\n"),
        ],
        { cwd: root, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
      );
      expect(JSON.parse(result)).toEqual({
        keys:
          reference === "namespace" && observedFile === "sdk/barrel.js"
            ? ["a", "b", "emptyNamespace"]
            : ["a", "b"],
        values: [42, 7, 7],
        empty: [],
        lazy: [],
        effect: 1,
        namespace: reference === "namespace" ? [] : null,
      });
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);
