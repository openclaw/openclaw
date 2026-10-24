import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { emitNativeDeclarations } from "../../scripts/lib/native-declaration-emitter.mts";
import { readNativeTypeScriptConfig } from "../../scripts/lib/native-typescript-config.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { materializeNativeCompiler, writeNativeFixtureFile } from "./native-boundary-fixture.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const tempRoot = (name: string) =>
  fs.realpathSync.native(roots.make(`native-declaration-${name}-`));
const moduleOptions = { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" };
function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    writeNativeFixtureFile(root, file, text);
  }
}

it("keeps test-only ambient augmentation out of declaration roots but in test graphs", () => {
  const ambient = path.resolve("src/config/sessions/session-entry.test-compat.d.ts");
  for (const [configFileName, included] of Object.entries({
    "tsconfig.json": false,
    "tsconfig.packages.json": false,
    "packages/plugin-sdk/tsconfig.json": false,
    "extensions/browser/tsconfig.json": false,
    "test/tsconfig/tsconfig.test.json": true,
    "src/tsconfig.json": true,
    "ui/tsconfig.json": true,
    "extensions/tsconfig.json": true,
  })) {
    expect(
      readNativeTypeScriptConfig({ cwd: process.cwd(), configFileName }).fileNames.includes(
        ambient,
      ),
      configFileName,
    ).toBe(included);
  }
});

it("rechecks a previously missing declaration path after its parent becomes a symlink", () => {
  const ancestor = fs.realpathSync.native(roots.make("declaration-path-recheck-"));
  const root = path.join(ancestor, "checkout");
  const outside = path.join(ancestor, "outside");
  const parent = path.join(root, "generated");
  const file = path.join(parent, "value.d.ts");
  fs.mkdirSync(root);
  writeFiles(outside, { "value.d.ts": "export {};\n" });
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

function createNativeFixture(root: string) {
  fs.mkdirSync(root, { recursive: true });
  materializeNativeCompiler(root);
  const write = (files: Record<string, string>, prefix = "") =>
    writeFiles(path.join(root, prefix), files);
  const json = (file: string, value: unknown) => write({ [file]: JSON.stringify(value) });
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
  const boundary = createDeclarationInputBoundary(root);
  const compile = (options: Partial<Parameters<typeof emitNativeDeclarations>[0]> = {}) =>
    emitNativeDeclarations({
      cwd: root,
      compilerRoot: root,
      configFile: path.join(root, "tsconfig.json"),
      roots: [path.join(root, "src/index.ts")],
      assertInput: (file) => boundary.assert(file),
      ...options,
    });
  return { write, json, compile };
}

it("rejects lazy global diagnostics", async () => {
  const fixture = createNativeFixture(tempRoot("errors"));
  fixture.write({ "src/index.ts": "export function* values() { yield 1; }" });
  await expect(fixture.compile({ compilerOptions: { lib: ["es5"] } })).rejects.toThrow(
    /TS2318: Cannot find global type 'IterableIterator'/u,
  );
});

it.runIf(process.platform === "win32")("rejects declaration transform errors", async () => {
  const fixture = createNativeFixture(tempRoot("declaration-error"));
  fixture.write({ "src/index.ts": "export const factory = () => class { private value = 1; };" });
  await expect(fixture.compile({ diagnostics: "declarations" })).rejects.toThrow(
    /TS4094: Property 'value' of exported anonymous class type/u,
  );
});

it("emits identical inferred declarations and maps across fresh compiler processes", async () => {
  const fixture = createNativeFixture(tempRoot("determinism"));
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
    // A local optional import must not admit another operand from an ancestor.
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
    "src/entry.ts":
      "export const local = widgetTypeOrigin;\nexport const fallback = rootTypeOrigin;\n",
  });
  fixture.write({
    "node_modules/@types/root-fallback/index.d.ts":
      'declare const rootTypeOrigin: "root-fallback";\n',
  });
  configure();
  const implicit = await emit();
  expect(implicit.declarations.get(entry)?.code).toContain('local: "widget-local"');
  expect(implicit.declarations.get(entry)?.code).toContain('fallback: "root-fallback"');

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

it("preserves default-glob path mappings and input framing through a newline checkout", async () => {
  // Windows forbids control characters in paths; all platforms still prove the default glob.
  const root = path.join(
    tempRoot("config-mutation"),
    process.platform === "win32" ? "plain" : "split\nname",
  );
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
  expect(stable.inputs).toContain(path.join(root, "contracts/before.ts"));
  expect(stable.inputs).not.toContain(path.join(root, "contracts/after.ts"));
  expect(fs.readdirSync(artifacts)).toEqual([]);
});
