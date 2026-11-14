import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { emitNativeDeclarations } from "../../scripts/lib/native-declaration-emitter.mts";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import { createNodeEvalArgs } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const tempRoot = (name: string) =>
  fs.realpathSync.native(roots.make(`native-declaration-${name}-`));
const moduleOptions = { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" };

it("keeps test-only ambient augmentation out of declaration roots but in test graphs", () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-production-roots-"));
  // Use the actual production/test selection rules with a tiny semantic-free fixture.
  const testConfigs = [
    "test/tsconfig/tsconfig.test.json",
    "src/tsconfig.json",
    "ui/tsconfig.json",
    "extensions/tsconfig.json",
  ];
  // Actual emit owners: tsgo:prod UI/plugin configs are noEmit typecheck graphs.
  const productionConfigs = [
    "tsconfig.json",
    "tsconfig.packages.json",
    "packages/plugin-sdk/tsconfig.json",
    "extensions/browser/tsconfig.json",
  ];
  for (const config of [
    ...productionConfigs,
    ...testConfigs,
    "config/tsconfig/oxlint.source.json",
    "extensions/tsconfig.package-boundary.paths.json",
    "extensions/tsconfig.package-boundary.base.json",
  ]) {
    writeNativeFixtureFile(root, config, fs.readFileSync(config, "utf8"));
  }
  const productionAmbient = "src/types/production.d.ts";
  const testAmbient = "src/config/sessions/session-entry.test-compat.d.ts";
  const packageAmbient = "packages/example/src/ambient.d.ts";
  const unrelatedAmbient = [
    "src/types/agent-sessions.d.ts",
    "ui/src/types/solid-elements.d.ts",
    "extensions/example/src/ambient.d.ts",
  ];
  for (const file of [
    packageAmbient,
    ...unrelatedAmbient,
    "packages/example/src/example.test-compat.d.ts",
  ]) {
    writeNativeFixtureFile(root, file, "export {};\n");
  }
  writeNativeFixtureFile(root, productionAmbient, "declare const productionOrigin: string;");
  writeNativeFixtureFile(root, testAmbient, 'import "./runtime.js";');
  writeNativeFixtureFile(root, "src/config/sessions/runtime.ts", "export const value = 1;");
  for (const file of [
    "packages/example/src/index.ts",
    "src/plugin-sdk/index.ts",
    "extensions/browser/src/index.ts",
  ]) {
    writeNativeFixtureFile(root, file, "export const value = 1;");
  }
  const configuredRoots = (configFileName: string) =>
    readNativeTypeScriptConfig({ cwd: root, configFileName }).fileNames.map((file) =>
      path.relative(root, file).replaceAll(path.sep, "/"),
    );
  const production = configuredRoots("tsconfig.json");
  expect(production).toContain(productionAmbient);
  expect(production).toEqual(expect.arrayContaining(unrelatedAmbient));
  expect(configuredRoots("tsconfig.packages.json").toSorted()).toEqual(
    [packageAmbient, "packages/example/src/index.ts"].toSorted(),
  );
  for (const config of productionConfigs) {
    expect(configuredRoots(config), config).not.toContain(testAmbient);
  }
  for (const config of testConfigs) {
    expect(configuredRoots(config), config).toContain(testAmbient);
  }
});

it("rechecks a previously missing declaration path after its parent becomes a symlink", () => {
  const ancestor = fs.realpathSync.native(roots.make("declaration-path-recheck-"));
  const root = path.join(ancestor, "checkout");
  const outside = path.join(ancestor, "outside");
  const parent = path.join(root, "generated");
  const file = path.join(parent, "value.d.ts");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "value.d.ts"), "export {};\n");
  const boundary = createDeclarationInputBoundary(root);
  expect(boundary.assert(file)).toBe(file);
  expect(boundary.assert(file)).toBe(file);

  fs.rmSync(parent, { recursive: true, force: true });
  fs.symlinkSync(outside, parent, "junction");
  expect(() => boundary.assert(file)).toThrow("Declaration input escapes checkout");

  fs.rmSync(parent, { recursive: true, force: true });
  fs.mkdirSync(parent);
  fs.writeFileSync(file, "export {};\n");
  expect(boundary.assert(file)).toBe(file);
});

function createNativeFixture(root: string, declared = root) {
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(declared);
  const write = (files: Record<string, string>, prefix = "") => {
    for (const [file, text] of Object.entries(files)) {
      writeNativeFixtureFile(root, prefix ? path.join(prefix, file) : file, text);
    }
  };
  const json = (file: string, value: unknown) => write({ [file]: JSON.stringify(value) });
  const expectInputs = (inputs: string[], ...files: string[]) =>
    expect(inputs).toEqual(expect.arrayContaining(files.map((file) => path.join(root, file))));
  write({ "package.json": '{"type":"module"}' });
  json("tsconfig.json", {
    compilerOptions: {
      ...moduleOptions,
      types: [],
      skipLibCheck: true,
      rootDir: "src",
      declaration: true,
      incremental: true,
    },
    files: ["src/index.ts"],
  });
  write({
    "src/index.ts":
      'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
  });
  const boundary = createDeclarationInputBoundary(declared);
  const compile = (options: Partial<Parameters<typeof emitNativeDeclarations>[0]> = {}) =>
    emitNativeDeclarations({
      cwd: declared,
      compilerRoot: declared,
      configFile: path.join(declared, "tsconfig.json"),
      roots: [path.join(declared, "src/index.ts")],
      assertInput: (file) => boundary.assert(file),
      ...options,
    });
  return { native, write, json, compile, expectInputs };
}

it.each([
  [
    "all",
    "lazy global",
    "export function* values() { yield 1; }",
    /TS2318: Cannot find global type 'IterableIterator'/u,
  ],
  [
    "declarations",
    "declaration transform",
    "export const factory = () => class { private value = 1; };",
    /TS4094: Property 'value' of exported anonymous class type/u,
  ],
] as const)("rejects %s diagnostic-mode %s errors", async (diagnostics, _kind, source, error) => {
  const root = tempRoot("errors");
  const fixture = createNativeFixture(root);
  fixture.write({ "src/index.ts": source });
  await expect(fixture.compile({ diagnostics, compilerOptions: { lib: ["es5"] } })).rejects.toThrow(
    error,
  );
});

it("emits identical inferred declarations and maps across fresh compiler processes", async () => {
  const root = tempRoot("determinism");
  const fixture = createNativeFixture(root);
  const modules = Array.from({ length: 16 }, (_, index) => `result-${index}`);
  fixture.write({
    "src/index.ts": modules.map((name) => `export * from "./${name}.js";`).join("\n"),
  });
  for (const [index, name] of modules.entries()) {
    const result =
      index % 2 ? '{ kind: "value", value } as const' : '{ kind: "value" as const, value }';
    fixture.write({
      [`src/${name}.ts`]: `export function result${index}<T>(ready: boolean, value: T) {
        return ready ? ${result} : { kind: "unavailable" as const };
      }`,
    });
  }
  const first = await fixture.compile();
  const second = await fixture.compile();
  expect(first.declarations.size).toBe(modules.length + 1);
  expect(second.declarations).toEqual(first.declarations);
  expect(second.inputs).toEqual(first.inputs);
});

it("bounds optional SDK relative imports and manifest probes to the checkout", async () => {
  const ancestor = tempRoot("optional-imports");
  const root = path.join(ancestor, ".worktrees/validation");
  const fixture = createNativeFixture(root);
  const entry = path.join(root, "src/index.ts");
  const localTypes = "node_modules/synthetic-fetch/index.d.ts";
  const requestTypes = (origin: string) => `export interface RequestInit { origin: "${origin}" }\n`;
  const config = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  delete config.compilerOptions.types;
  fixture.write({
    "tsconfig.json": JSON.stringify(config),
    [path.join(ancestor, "node_modules/@types/parent-only/index.d.ts")]:
      'declare const parentOnly: "ancestor";\n',
    "node_modules/synthetic-sdk/package.json":
      '{"name":"synthetic-sdk","type":"module","types":"internal/types.d.ts"}',
  });
  // SDKs union optional imports at multiple parent depths; a local hit does not
  // prevent another operand from resolving an ancestor's installed declarations.
  fixture.write({
    "node_modules/synthetic-sdk/internal/types.d.ts": [
      "type NotAny<T> = [0] extends [1 & T] ? never : T;",
      "export type Options =",
      ...Array.from({ length: 7 }, (_, index) => [
        "// @ts-ignore Optional fetch types may be absent at this depth.",
        `  ${index ? "| " : ""}NotAny<import("${"../".repeat(index + 1)}node_modules/synthetic-fetch/index.d.ts").RequestInit>`,
      ]).flat(),
      ";",
      'export type Fallback = typeof import("synthetic-js");',
    ].join("\n"),
    [localTypes]: requestTypes("local"),
    [path.join(ancestor, "node_modules/synthetic-fetch/index.d.ts")]: requestTypes("ancestor"),
  });
  const manifest = '{"name":"synthetic-js","version":"1.0.0","main":"index.js"}';
  for (const directory of [root, ancestor]) {
    fixture.write({
      [path.join(directory, "node_modules/synthetic-js/package.json")]: manifest,
      [path.join(directory, "node_modules/synthetic-js/index.js")]: "exports.value = 1;\n",
    });
  }
  fixture.write({
    "src/index.ts":
      'import type { Options } from "synthetic-sdk";\nexport type { Fallback } from "synthetic-sdk";\nexport function origin(options: Options) { return options.origin; }\n',
  });
  const first = await fixture.compile();
  expect(first.declarations.get(entry)?.code).toContain('origin(options: Options): "local"');
  fixture.expectInputs(
    first.inputs,
    "src/index.ts",
    localTypes,
    "node_modules/synthetic-sdk/package.json",
    "node_modules/synthetic-js/package.json",
  );
  expect(first.inputs.every((file) => !path.relative(root, file).startsWith(".."))).toBe(true);

  fixture.write({
    [path.join(ancestor, "node_modules/synthetic-fetch/index.d.ts")]:
      requestTypes("changed-ancestor"),
    [path.join(ancestor, "node_modules/synthetic-js/package.json")]:
      '{"name":"synthetic-js","version":"2.0.0","main":"missing.js"}',
  });
  const ancestorChanged = await fixture.compile();
  expect(ancestorChanged.declarations.get(entry)).toEqual(first.declarations.get(entry));
  expect(ancestorChanged.inputs).toEqual(first.inputs);

  fixture.write({ [localTypes]: requestTypes("changed-local") });
  const localChanged = await fixture.compile();
  expect(localChanged.declarations.get(entry)?.code).toContain(
    'origin(options: Options): "changed-local"',
  );
});

for (const kind of [
  "directory alias",
  "Windows 8.3 alias",
  "directory alias targeting Windows 8.3",
  "Windows namespaced executable",
]) {
  it.skipIf(kind.includes("Windows") && process.platform !== "win32")(
    `emits and captures checkout-local inputs through a ${kind}`,
    async (context) => {
      const ancestor = tempRoot("alias");
      const longExecutable = kind === "Windows namespaced executable";
      const directory = longExecutable ? "LongNativeCheckout".repeat(10) : "validation";
      const root = path.join(ancestor, ".claude/worktrees", directory);
      fs.mkdirSync(root, { recursive: true });
      let target = root;
      if (kind.includes("8.3")) {
        const short = resolveNativeFixtureShortPath(root);
        if (!short) {
          context.skip("Filesystem does not expose a distinct Windows 8.3 checkout alias");
          return;
        }
        target = short;
      }
      let declared = target;
      if (kind.startsWith("directory alias") || longExecutable) {
        declared = path.join(path.dirname(root), "declared-alias");
        fs.symlinkSync(target, declared, "junction");
      }
      if (kind === "directory alias targeting Windows 8.3") {
        expect(fs.realpathSync(declared)).not.toBe(declared);
        expect(fs.realpathSync(declared)).not.toBe(root);
      }
      const f = createNativeFixture(root, declared);
      if (longExecutable) {
        // Exercise the actual installed getExePath contract, not a synthetic path adapter.
        expect(f.native.startsWith("\\\\?\\")).toBe(true);
        expect(f.native.slice(4).length).toBeGreaterThanOrEqual(248);
      }
      installNativeAncestorTypes(ancestor, root);
      const run = await f.compile();
      expect(run.declarations.get(path.join(root, "src/index.ts"))?.code).toContain(
        'inferredOrigin: "local"',
      );
      f.expectInputs(
        run.inputs,
        "src/index.ts",
        "node_modules/.pnpm/core/node_modules/@types/synthetic-core/index.d.ts",
        "node_modules/.pnpm/core/node_modules/@types/synthetic-core/package.json",
      );
      expect(run.inputs.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
      expect(run.inputs.every((file) => !path.relative(root, file).startsWith(".."))).toBe(true);
    },
  );
}

it("rejects a native reference through an unrelated outside symlink back inside", async () => {
  const ancestor = tempRoot("symlink-back");
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const f = createNativeFixture(root);
  const outside = path.join(ancestor, "outside-reference");
  fs.symlinkSync(path.join(root, "src"), outside, "junction");
  f.write({ "src/referenced.d.ts": 'interface FixtureContract { origin: "local" }\n' });
  const reference = path.join(outside, "referenced.d.ts");
  f.write({
    "src/index.ts": `/// <reference path="${reference.replaceAll(path.sep, "/")}" />\nexport type Marker = FixtureContract;\n`,
  });
  expect(fs.realpathSync.native(reference)).toBe(path.join(root, "src/referenced.d.ts"));
  await expect(f.compile()).rejects.toThrow(/TS6053/);
});

it("preserves original nested config paths and explicit override precedence during native emission", async () => {
  const root = tempRoot("config-context");
  const fixture = createNativeFixture(root);
  const widget = "packages/widget";
  const entry = path.join(root, widget, "src/entry.ts");
  const write = (files: Record<string, string>) => fixture.write(files, widget);
  const configure = (compilerOptions: Record<string, unknown> = {}) =>
    fixture.json("config/widget-base.json", {
      compilerOptions: {
        ...moduleOptions,
        strict: true,
        skipLibCheck: true,
        types: ["*"],
        ...compilerOptions,
      },
    });
  const emit = (compilerOptions?: Record<string, unknown>) =>
    fixture.compile({
      configFile: path.join(root, widget, "tsconfig.json"),
      roots: [entry],
      compilerOptions,
    });
  write({ "package.json": '{"type":"module"}' });
  fixture.json(`${widget}/tsconfig.json`, {
    extends: "../../config/widget-base.json",
    files: ["src/entry.ts"],
    include: [],
  });
  write({
    "node_modules/@types/widget-local/index.d.ts":
      'declare const widgetTypeOrigin: "widget-local";\n',
  });
  fixture.write({
    "node_modules/@types/root-fallback/index.d.ts":
      'declare const rootTypeOrigin: "root-fallback";\n',
  });
  configure();
  write({
    "src/entry.ts":
      "export const local = widgetTypeOrigin;\nexport const fallback = rootTypeOrigin;\n",
  });
  const implicit = await emit();
  expect(implicit.declarations.get(entry)?.code).toContain('local: "widget-local"');
  expect(implicit.declarations.get(entry)?.code).toContain('fallback: "root-fallback"');
  fixture.expectInputs(
    implicit.inputs,
    `${widget}/node_modules/@types/widget-local/index.d.ts`,
    "node_modules/@types/root-fallback/index.d.ts",
  );

  const inheritedOptions = {
    typeRoots: ["${configDir}/custom-types"],
    paths: { "#contract": ["${configDir}/contracts/inherited.ts"] },
    rootDirs: ["${configDir}/src", "${configDir}/generated"],
  };
  const rawOverrides = {
    typeRoots: ["./override-types"],
    paths: { "#contract": ["./contracts/override.ts"] },
    rootDirs: ["./src", "./override-generated"],
  };
  configure(inheritedOptions);
  write({
    "src/entry.ts":
      'import { contract } from "#contract";\nimport { peer } from "./peer.js";\nexport const resolvedContract = contract;\nexport const resolvedPeer = peer;\nexport const configuredType = configuredTypeOrigin;\n',
  });
  for (const [types, contract, generated, typeOrigin, peer] of [
    ["custom-types", "inherited", "generated", "config-dir", "root-dir"],
    ["override-types", "override", "override-generated", "override-type", "override-root"],
  ] as const) {
    write({
      [`${types}/marker/index.d.ts`]: `declare const configuredTypeOrigin: "${typeOrigin}";\n`,
      [`contracts/${contract}.ts`]: `export const contract = "${contract}";\n`,
      [`${generated}/peer.ts`]: `export const peer = "${peer}";\n`,
    });
    const emitted = await emit(contract === "override" ? rawOverrides : undefined);
    const code = emitted.declarations.get(entry)?.code;
    expect(code).toMatch(new RegExp(`resolvedContract\\s*(?::|=)\\s*"${contract}"`, "u"));
    expect(code).toMatch(new RegExp(`resolvedPeer\\s*(?::|=)\\s*"${peer}"`, "u"));
    expect(code).toContain(`configuredType: "${typeOrigin}"`);
    fixture.expectInputs(
      emitted.inputs,
      `${widget}/${types}/marker/index.d.ts`,
      `${widget}/contracts/${contract}.ts`,
      `${widget}/${generated}/peer.ts`,
    );
    const excluded =
      contract === "override"
        ? "contracts/inherited.ts"
        : "node_modules/@types/widget-local/index.d.ts";
    expect(emitted.inputs).not.toContain(path.join(root, widget, excluded));
  }
  // This name exists in an implicit local root, so an accidental fallback would pass.
  write({ "src/entry.ts": "export const mustBeMissing = widgetTypeOrigin;\n" });
  await expect(emit({ ...rawOverrides, typeRoots: [] })).rejects.toThrow(
    /TS2304: Cannot find name 'widgetTypeOrigin'/u,
  );
  configure({ ...inheritedOptions, typeRoots: [] });
  await expect(emit()).rejects.toThrow(/TS2304: Cannot find name 'widgetTypeOrigin'/u);
  expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
});

it("preserves default-glob emission with inherited path mappings", async () => {
  const root = tempRoot("config-mutation");
  const fixture = createNativeFixture(root);
  const entry = path.join(root, "src/index.ts");
  const artifacts = path.join(root, ".artifacts");
  fixture.json("tsconfig.json", {
    compilerOptions: {
      ...moduleOptions,
      types: [],
      paths: { "#contract": ["./contracts/before.ts"] },
    },
  });
  fixture.write({
    "contracts/before.ts": 'export const origin = "before";\n',
    "contracts/after.ts": 'export const origin = "after";\n',
    "src/index.ts": 'import { origin } from "#contract";\nexport const resolvedOrigin = origin;\n',
  });
  // No files/include/exclude: the original default glob must not admit its private output.
  const stable = await fixture.compile();
  expect(stable.declarations.get(entry)?.code).toMatch(/resolvedOrigin\s*(?::|=)\s*"before"/u);
  expect(stable.inputs).not.toContain(path.join(root, "contracts/after.ts"));
  expect(fs.readdirSync(artifacts)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "emits declarations from a checkout path containing a line break",
  () => {
    const parent = tempRoot("trace-framing");
    // Windows does not permit control characters in file names.
    const root = path.join(parent, "split\nname");
    const fixture = createNativeFixture(root);
    fixture.write({
      "src/index.ts": 'export type { Marker } from "./contract.js";\n',
      "src/contract.ts": "export interface Marker { value: 1 }\n",
    });
    // Vitest's external-module loader normalizes the newline in the compiler path.
    const result = spawnSync(
      process.execPath,
      createNodeEvalArgs(
        `import path from "node:path";
        import { emitNativeDeclarations } from ${JSON.stringify(new URL("../../scripts/lib/native-declaration-emitter.mts", import.meta.url).href)};
        import { createDeclarationInputBoundary } from ${JSON.stringify(new URL("../../scripts/lib/local-check-runtime.mts", import.meta.url).href)};
        const root = ${JSON.stringify(root)};
        const boundary = createDeclarationInputBoundary(root);
        const emitted = await emitNativeDeclarations({
          cwd: root, compilerRoot: root, configFile: path.join(root, "tsconfig.json"),
          roots: [path.join(root, "src/index.ts")], assertInput: (file) => boundary.assert(file),
        });
        console.log(JSON.stringify({
          declaration: emitted.declarations.get(path.join(root, "src/index.ts"))?.code,
          inputs: emitted.inputs,
        }));`,
        { imports: [import.meta.resolve("tsx")] },
      ),
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const emitted: unknown = JSON.parse(result.stdout);
    expect(emitted).toEqual({
      declaration: expect.stringContaining('export type { Marker } from "./contract.js"'),
      inputs: expect.arrayContaining([path.join(root, "src/contract.ts")]),
    });
    expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
  },
);
