import fs from "node:fs";
import path from "node:path";
import { Program } from "typescript/unstable/async";
import { afterEach, expect, it, vi } from "vitest";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { emitNativeDeclarations } from "../../scripts/lib/native-declaration-emitter.mts";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  installNativeAncestorTypes,
  materializeNativeCompiler,
  resolveNativeFixtureShortPath,
  writeNativeFixtureFile,
} from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

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
    "packages/plugin-sdk/tsconfig.json",
    "extensions/browser/tsconfig.json",
  ];
  for (const config of [
    ...productionConfigs,
    ...testConfigs,
    "extensions/tsconfig.package-boundary.paths.json",
    "extensions/tsconfig.package-boundary.base.json",
  ]) {
    writeNativeFixtureFile(root, config, fs.readFileSync(config, "utf8"));
  }
  const productionAmbient = "src/types/production.d.ts";
  const testAmbient = "src/config/sessions/session-entry.test-compat.d.ts";
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
  for (const config of productionConfigs) {
    expect(configuredRoots(config), config).not.toContain(testAmbient);
  }
  for (const config of testConfigs) {
    expect(configuredRoots(config), config).toContain(testAmbient);
  }
});

it.each([true, false])(
  "diagnoses declaration escapes with an ancestor install=%s",
  (ancestorInstall) => {
    const ancestor = fs.realpathSync.native(roots.make("declaration-escape-diagnosis-"));
    const root = path.join(ancestor, ".claude/worktrees/validation");
    fs.mkdirSync(root, { recursive: true });
    const install = path.join(ancestor, ancestorInstall ? "node_modules" : "other/node_modules");
    const file = path.join(install, "synthetic-package/package.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    const boundary = createDeclarationInputBoundary(root);
    expect(() => boundary.assert(file)).toThrow(`Declaration input escapes checkout: ${file}`);
    expect(() => boundary.assert(file)).toThrow(
      "shared installs and external symlinks are unsupported",
    );
    expect(() => boundary.assert(file)).toThrow(
      "does not establish a missing or undeclared dependency",
    );
  },
);

function createNativeFixture(root: string, declared = root) {
  fs.mkdirSync(root, { recursive: true });
  const native = materializeNativeCompiler(declared);
  const write = (file: string, text: string) => writeNativeFixtureFile(root, file, text);
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        types: [],
        skipLibCheck: true,
        rootDir: "src",
        declaration: true,
        incremental: true,
      },
      files: ["src/index.ts"],
    }),
  );
  write(
    "src/index.ts",
    'import type { Marker } from "synthetic-wrapper";\nexport type { Marker };\nexport const inferredOrigin = declarationOrigin;\n',
  );
  const boundary = createDeclarationInputBoundary(declared);
  const compile = () =>
    emitNativeDeclarations({
      cwd: declared,
      compilerRoot: declared,
      configFile: path.join(declared, "tsconfig.json"),
      roots: [path.join(declared, "src/index.ts")],
      assertInput: (file) => boundary.assert(file),
    });
  return { native, write, compile };
}

it.each(
  (["all", "declarations"] as const).flatMap((diagnostics) => [
    {
      diagnostics,
      kind: "declaration transform",
      source: "export const factory = () => class { private value = 1; };",
      error: /TS4094: Property 'value' of exported anonymous class type/u,
    },
    {
      diagnostics,
      kind: "lazy global",
      source: "export function* values() { yield 1; }",
      error: /TS2318: Cannot find global type 'IterableIterator'/u,
    },
  ]),
)(
  "rejects $kind errors in $diagnostics diagnostic mode",
  async ({ diagnostics, source, error }) => {
    const root = fs.realpathSync.native(roots.make("native-declaration-errors-"));
    const fixture = createNativeFixture(root);
    fixture.write("src/index.ts", source);
    const boundary = createDeclarationInputBoundary(root);
    await expect(
      emitNativeDeclarations({
        cwd: root,
        compilerRoot: root,
        configFile: path.join(root, "tsconfig.json"),
        roots: [path.join(root, "src/index.ts")],
        diagnostics,
        compilerOptions: { lib: ["es5"] },
        assertInput: (file) => boundary.assert(file),
      }),
    ).rejects.toThrow(error);
  },
);

it("rejects semantic errors before returning valid native declarations", async () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-semantics-"));
  const fixture = createNativeFixture(root);
  fixture.write("src/index.ts", 'export const count: number = "wrong";');
  await expect(fixture.compile()).rejects.toThrow(/TS2322: Type 'string' is not assignable/u);

  fixture.write("src/index.ts", "export const count: number = 42;");
  const emitted = await fixture.compile();
  expect(emitted.declarations.get(path.join(root, "src/index.ts"))?.code).toContain(
    "export declare const count: number;",
  );
});

it("bounds optional SDK relative imports and manifest probes to the checkout", async () => {
  const ancestor = fs.realpathSync.native(roots.make("native-declaration-optional-imports-"));
  const root = path.join(ancestor, ".worktrees/validation");
  const fixture = createNativeFixture(root);
  const entry = path.join(root, "src/index.ts");
  const boundary = createDeclarationInputBoundary(root);
  const localTypes = "node_modules/synthetic-fetch/index.d.ts";
  const requestTypes = (origin: string) => `export interface RequestInit { origin: "${origin}" }\n`;
  const config = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  delete config.compilerOptions.types;
  fixture.write("tsconfig.json", JSON.stringify(config));
  fixture.write(
    path.join(ancestor, "node_modules/@types/parent-only/index.d.ts"),
    'declare const parentOnly: "ancestor";\n',
  );
  fixture.write(
    "node_modules/synthetic-sdk/package.json",
    '{"name":"synthetic-sdk","type":"module","types":"internal/types.d.ts"}',
  );
  // SDKs union optional imports at multiple parent depths; a local hit does not
  // prevent another operand from resolving an ancestor's installed declarations.
  fixture.write(
    "node_modules/synthetic-sdk/internal/types.d.ts",
    [
      "type NotAny<T> = [0] extends [1 & T] ? never : T;",
      "export type Options =",
      ...Array.from({ length: 7 }, (_, index) => [
        "// @ts-ignore Optional fetch types may be absent at this depth.",
        `  ${index ? "| " : ""}NotAny<import("${"../".repeat(index + 1)}node_modules/synthetic-fetch/index.d.ts").RequestInit>`,
      ]).flat(),
      ";",
      'export type Fallback = typeof import("synthetic-js");',
    ].join("\n"),
  );
  fixture.write(localTypes, requestTypes("local"));
  fixture.write(
    path.join(ancestor, "node_modules/synthetic-fetch/index.d.ts"),
    requestTypes("ancestor"),
  );
  const manifest = '{"name":"synthetic-js","version":"1.0.0","main":"index.js"}';
  for (const directory of [root, ancestor]) {
    fixture.write(path.join(directory, "node_modules/synthetic-js/package.json"), manifest);
    fixture.write(
      path.join(directory, "node_modules/synthetic-js/index.js"),
      "exports.value = 1;\n",
    );
  }
  fixture.write(
    "src/index.ts",
    'import type { Options } from "synthetic-sdk";\nexport type { Fallback } from "synthetic-sdk";\nexport function origin(options: Options) { return options.origin; }\n',
  );
  const emit = () =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile: path.join(root, "tsconfig.json"),
      roots: [entry],
      assertInput: (file) => boundary.assert(file),
    });
  const first = await emit();
  expect(first.declarations.get(entry)?.code).toContain('origin(options: Options): "local"');
  expect(first.inputs).toEqual(
    expect.arrayContaining(
      [
        "src/index.ts",
        localTypes,
        "node_modules/synthetic-sdk/package.json",
        "node_modules/synthetic-js/package.json",
      ].map((file) => path.join(root, file)),
    ),
  );
  expect(first.inputs.every((file) => !path.relative(root, file).startsWith(".."))).toBe(true);

  fixture.write(
    path.join(ancestor, "node_modules/synthetic-fetch/index.d.ts"),
    requestTypes("changed-ancestor"),
  );
  fixture.write(
    path.join(ancestor, "node_modules/synthetic-js/package.json"),
    '{"name":"synthetic-js","version":"2.0.0","main":"missing.js"}',
  );
  const ancestorChanged = await emit();
  expect(ancestorChanged.declarations.get(entry)).toEqual(first.declarations.get(entry));
  expect(ancestorChanged.inputs).toEqual(first.inputs);

  fixture.write(localTypes, requestTypes("changed-local"));
  const localChanged = await emit();
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
      const ancestor = fs.realpathSync.native(roots.make("native-declaration-alias-"));
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
      expect(run.inputs).toContain(path.join(root, "src/index.ts"));
      expect(run.inputs).toContain(
        path.join(root, "node_modules/.pnpm/core/node_modules/@types/synthetic-core/index.d.ts"),
      );
      expect(run.inputs).toContain(
        path.join(root, "node_modules/.pnpm/core/node_modules/@types/synthetic-core/package.json"),
      );
      expect(run.inputs.some((file) => file.endsWith("/lib.es2023.d.ts"))).toBe(true);
      expect(run.inputs.every((file) => !path.relative(root, file).startsWith(".."))).toBe(true);
    },
  );
}

it("rejects a native reference through an unrelated outside symlink back inside", async () => {
  const ancestor = fs.realpathSync.native(roots.make("native-declaration-symlink-back-"));
  const root = path.join(ancestor, ".claude/worktrees/validation");
  const f = createNativeFixture(root);
  const outside = path.join(ancestor, "outside-reference");
  fs.symlinkSync(path.join(root, "src"), outside, "junction");
  f.write("src/referenced.d.ts", 'interface FixtureContract { origin: "local" }\n');
  const reference = path.join(outside, "referenced.d.ts");
  f.write(
    "src/index.ts",
    `/// <reference path="${reference.replaceAll(path.sep, "/")}" />\nexport type Marker = FixtureContract;\n`,
  );
  expect(fs.realpathSync.native(reference)).toBe(path.join(root, "src/referenced.d.ts"));
  await expect(f.compile()).rejects.toThrow(/TS6053/);
});

it("preserves original nested config paths and explicit override precedence during native emission", async () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-config-context-"));
  const fixture = createNativeFixture(root);
  const widget = "packages/widget";
  const entry = path.join(root, widget, "src/entry.ts");
  const configFile = path.join(root, widget, "tsconfig.json");
  const boundary = createDeclarationInputBoundary(root);
  const commonOptions = {
    module: "NodeNext",
    moduleResolution: "NodeNext",
    target: "ES2023",
    strict: true,
    skipLibCheck: true,
    types: ["*"],
  };
  const configure = (compilerOptions: Record<string, unknown> = {}) =>
    fixture.write(
      "config/widget-base.json",
      JSON.stringify({ compilerOptions: { ...commonOptions, ...compilerOptions } }),
    );
  const emit = (compilerOptions?: Record<string, unknown>) =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile,
      roots: [entry],
      compilerOptions,
      assertInput: (file) => boundary.assert(file),
    });
  fixture.write(`${widget}/package.json`, '{"type":"module"}');
  fixture.write(
    `${widget}/tsconfig.json`,
    JSON.stringify({
      extends: "../../config/widget-base.json",
      files: ["src/entry.ts"],
      include: [],
    }),
  );
  fixture.write(
    `${widget}/node_modules/@types/widget-local/index.d.ts`,
    'declare const widgetTypeOrigin: "widget-local";\n',
  );
  fixture.write(
    "node_modules/@types/root-fallback/index.d.ts",
    'declare const rootTypeOrigin: "root-fallback";\n',
  );
  configure();
  fixture.write(
    `${widget}/src/entry.ts`,
    "export const local = widgetTypeOrigin;\nexport const fallback = rootTypeOrigin;\n",
  );
  const implicit = await emit();
  expect(implicit.declarations.get(entry)?.code).toContain('local: "widget-local"');
  expect(implicit.declarations.get(entry)?.code).toContain('fallback: "root-fallback"');
  expect(implicit.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "node_modules/@types/widget-local/index.d.ts"),
      path.join(root, "node_modules/@types/root-fallback/index.d.ts"),
    ]),
  );

  const inheritedOptions = {
    typeRoots: ["${configDir}/custom-types"],
    paths: { "#contract": ["${configDir}/contracts/inherited.ts"] },
    rootDirs: ["${configDir}/src", "${configDir}/generated"],
  };
  configure(inheritedOptions);
  fixture.write(
    `${widget}/custom-types/marker/index.d.ts`,
    'declare const configuredTypeOrigin: "config-dir";\n',
  );
  fixture.write(`${widget}/contracts/inherited.ts`, 'export const contract = "inherited";\n');
  fixture.write(`${widget}/generated/peer.ts`, 'export const peer = "root-dir";\n');
  fixture.write(
    `${widget}/src/entry.ts`,
    'import { contract } from "#contract";\nimport { peer } from "./peer.js";\nexport const resolvedContract = contract;\nexport const resolvedPeer = peer;\nexport const configuredType = configuredTypeOrigin;\n',
  );
  const inherited = await emit();
  expect(inherited.declarations.get(entry)?.code).toMatch(
    /resolvedContract\s*(?::|=)\s*"inherited"/u,
  );
  expect(inherited.declarations.get(entry)?.code).toMatch(/resolvedPeer\s*(?::|=)\s*"root-dir"/u);
  expect(inherited.declarations.get(entry)?.code).toContain('configuredType: "config-dir"');
  expect(inherited.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "custom-types/marker/index.d.ts"),
      path.join(root, widget, "contracts/inherited.ts"),
      path.join(root, widget, "generated/peer.ts"),
    ]),
  );
  expect(inherited.inputs).not.toContain(
    path.join(root, widget, "node_modules/@types/widget-local/index.d.ts"),
  );

  fixture.write(
    `${widget}/override-types/marker/index.d.ts`,
    'declare const configuredTypeOrigin: "override-type";\n',
  );
  fixture.write(`${widget}/contracts/override.ts`, 'export const contract = "override";\n');
  fixture.write(`${widget}/override-generated/peer.ts`, 'export const peer = "override-root";\n');
  const rawOverrides = {
    typeRoots: ["./override-types"],
    paths: { "#contract": ["./contracts/override.ts"] },
    rootDirs: ["./src", "./override-generated"],
  };
  const overridden = await emit(rawOverrides);
  expect(overridden.declarations.get(entry)?.code).toMatch(
    /resolvedContract\s*(?::|=)\s*"override"/u,
  );
  expect(overridden.declarations.get(entry)?.code).toMatch(
    /resolvedPeer\s*(?::|=)\s*"override-root"/u,
  );
  expect(overridden.declarations.get(entry)?.code).toContain('configuredType: "override-type"');
  expect(overridden.inputs).toEqual(
    expect.arrayContaining([
      path.join(root, widget, "override-types/marker/index.d.ts"),
      path.join(root, widget, "contracts/override.ts"),
      path.join(root, widget, "override-generated/peer.ts"),
    ]),
  );
  expect(overridden.inputs).not.toContain(path.join(root, widget, "contracts/inherited.ts"));

  // This name exists in an implicit local root, so an accidental fallback would pass.
  fixture.write(`${widget}/src/entry.ts`, "export const mustBeMissing = widgetTypeOrigin;\n");
  await expect(emit({ ...rawOverrides, typeRoots: [] })).rejects.toThrow(
    /TS2304: Cannot find name 'widgetTypeOrigin'/u,
  );
  configure({ ...inheritedOptions, typeRoots: [] });
  await expect(emit()).rejects.toThrow(/TS2304: Cannot find name 'widgetTypeOrigin'/u);
  expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
});

it("rejects config paths changed after materialization while preserving default-glob emission", async () => {
  const root = fs.realpathSync.native(roots.make("native-declaration-config-mutation-"));
  const fixture = createNativeFixture(root);
  const entry = path.join(root, "src/index.ts");
  const configFile = path.join(root, "tsconfig.json");
  const artifacts = path.join(root, ".artifacts");
  const boundary = createDeclarationInputBoundary(root);
  const configuration = (origin: string) =>
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        types: [],
        paths: { "#contract": [`./contracts/${origin}.ts`] },
      },
    });
  fixture.write("tsconfig.json", configuration("before"));
  fixture.write("contracts/before.ts", 'export const origin = "before";\n');
  fixture.write("contracts/after.ts", 'export const origin = "after";\n');
  fixture.write(
    "src/index.ts",
    'import { origin } from "#contract";\nexport const resolvedOrigin = origin;\n',
  );
  const emit = () =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile,
      roots: [entry],
      assertInput: (file) => boundary.assert(file),
    });

  // No files/include/exclude: the original default glob must not admit its private output.
  const stable = await emit();
  expect(stable.declarations.get(entry)?.code).toMatch(/resolvedOrigin\s*(?::|=)\s*"before"/u);
  expect(stable.inputs).not.toContain(path.join(root, "contracts/after.ts"));
  expect(fs.readdirSync(artifacts)).toEqual([]);

  let changed = false;
  const emitter = vi
    .spyOn(Program.prototype, "emitToString")
    .mockImplementationOnce(async function (this: Program, ...args) {
      emitter.mockRestore();
      const output = await this.emitToString(...args);
      changed = true;
      fs.writeFileSync(configFile, configuration("after"));
      return output;
    });
  try {
    await expect(emit()).rejects.toThrow(/Boundary .*changed during compilation/u);
  } finally {
    emitter.mockRestore();
  }
  expect(changed).toBe(true);
  expect(fs.readFileSync(configFile, "utf8")).toBe(configuration("after"));
  expect(fs.readdirSync(artifacts)).toEqual([]);
});

it.skipIf(process.platform === "win32")(
  "emits declarations from a checkout path containing a line break",
  async () => {
    const parent = fs.realpathSync.native(roots.make("native-declaration-trace-framing-"));
    // Windows does not permit control characters in file names.
    const root = path.join(parent, "split\nname");
    const fixture = createNativeFixture(root);
    fixture.write("src/index.ts", 'export type { Marker } from "./contract.js";\n');
    fixture.write("src/contract.ts", "export interface Marker { value: 1 }\n");
    const emitted = await fixture.compile();
    expect(emitted.declarations.get(path.join(root, "src/index.ts"))?.code).toContain(
      'export type { Marker } from "./contract.js"',
    );
    expect(emitted.inputs).toContain(path.join(root, "src/contract.ts"));
    expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
  },
);
