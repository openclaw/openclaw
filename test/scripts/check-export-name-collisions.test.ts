import { afterAll, expect, it } from "vitest";
import {
  collectModuleExportNames,
  collectRepositoryCollisions,
  findAliasingReExports,
  findExportNameCollisions,
} from "../../scripts/check-export-name-collisions.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const sources = (files: Record<string, string>) =>
  Object.entries(files).map(([path, content]) => ({ path, content }));
const collisions = (files: Record<string, string>) => findExportNameCollisions(sources(files));
const collision = (name: string, ...files: string[]) => ({ name, files: files.toSorted() });
function exportsOf(content: string, file = "src/facade.ts") {
  return collectModuleExportNames(file, parser.parseSourceFile(file, content));
}

it("finds exported function and const definitions across modules", () => {
  expect(
    collisions({
      "src/a.ts": "export function g() {}",
      "src/b.ts": "export const g = () => {};",
      "src/c.ts": "async function f() {} export { f };",
      "src/d.mts": "export async function f() {}",
    }),
  ).toEqual([collision("f", "src/c.ts", "src/d.mts"), collision("g", "src/a.ts", "src/b.ts")]);
});

it("ignores types, pure re-exports, imports exported locally, and renamed exports", () => {
  const result = exportsOf(`
    import { imported } from "./other.js";
    interface LocalShape {} type LocalType = string;
    export { imported };
    export { remote } from "./remote.js";
    export { remote as renamed } from "./remote.js";
    export * from "./barrel.js";
    export interface Shape {} export type Type = string;
  `);
  expect([...result.definitions]).toEqual([]);
  expect([...result.exportedNames]).toEqual(["imported", "remote"]);
});

it.each([
  [
    "loadFreeBsdProcessIdentityNative",
    "otherBehavior",
    "src/extra.ts",
    [
      "src/infra/package-update-activation-native-loader.ts",
      "src/infra/update-managed-service-handoff-native-loader.ts",
      "src/shared/freebsd-process-identity-native.ts",
    ],
  ],
  [
    "openExistingSqliteWorkerBackend",
    "bindSqliteWorkerBackend",
    "src/unrelated/extra.worker.ts",
    ["src/state/openclaw-state.worker.ts", "src/state/openclaw-agent-execution.worker.ts"],
  ],
] as const)("limits %s exemptions to the exact approved modules", (name, other, extra, paths) => {
  const modules = (symbol: string, files: readonly string[]) =>
    files.map((path) => ({ path, content: `export function ${symbol}() {}` }));
  expect(findExportNameCollisions(modules(name, paths))).toEqual([]);
  expect(findExportNameCollisions(modules(name, [...paths, extra]))).toEqual([
    collision(name, ...paths, extra),
  ]);
  expect(findExportNameCollisions(modules(other, paths))).toEqual([collision(other, ...paths)]);
});

it("reports direct aliasing re-exports only outside the Plugin SDK", () => {
  expect(
    findAliasingReExports([
      ...sources({
        "src/alias.ts": `
        export { original } from "./source.js";
        export type { OriginalType as RenamedType } from "./source.js";
        export { original as renamed } from "./source.js";
      `,
        "src/local.ts": 'import { original } from "./source.js"; export { original as local };',
        "src/plugin-sdk/alias.ts": 'export { original as sanctioned } from "../source.js";',
      }),
      {
        path: "packages/support.ts",
        content: 'export { original as alias } from "./source.js";',
        includeDefinitions: false,
      },
    ]),
  ).toEqual([
    {
      exportedName: "renamed",
      importedName: "original",
      line: 4,
      moduleSpecifier: "./source.js",
      path: "src/alias.ts",
    },
  ]);
});

const imported = (body: string) => `import { f as impl } from "./f.js"; ${body}`;
const runtime = (body: string) => `export async function f(...args: unknown[]) { ${body} }`;
it.each([
  imported("export function f(a: string, b?: number) { return impl(a, b); }"),
  imported("export const f = impl;"),
  imported("export const f = (a: string, b?: number) => impl(a, b);"),
  "export const f = async (...args: unknown[]) => { const r = await load(); return r.f(...args); };",
  runtime("return (await load()).f(...args);"),
  runtime("const r = await load(); return r.f(...args);"),
  'import { createLazyRuntimeMethodBinder as bind } from "./shared/lazy-runtime.js"; const b = bind(load); export const f = b(r => r.f);',
  'import { createLazyRuntimeMethod } from "openclaw/plugin-sdk/lazy-runtime"; export const f = createLazyRuntimeMethod(load, r => r.f);',
])("exempts exact same-name forwarder: %s", (content) => {
  expect([...exportsOf(content).definitions]).toEqual([]);
});

it.each([
  ["computed import", "const r = await import(target); return r.f(...args);"],
  ["added argument", 'const r = await import("./runtime.js"); return r.f(...args, fallback);'],
  ["changed member", 'const r = await import("./runtime.js"); return r.other(...args);'],
])("keeps a dynamic-import wrapper with %s as a collision", (_label, body) => {
  expect(
    collisions({ "src/facade.ts": runtime(body), "src/runtime.ts": "export function f() {}" }),
  ).toEqual([collision("f", "src/facade.ts", "src/runtime.ts")]);
});

it("records a type-asserted namespace element alias as a re-export instead of a value definition", () => {
  const result = exportsOf(
    'import * as r from "./inner.js"; export const f = (r["f"] as () => string);',
  );
  expect([...result.exportedNames]).toEqual(["f"]);
  expect([...result.definitions]).toEqual([]);
  expect([...result.valueDefinitions]).toEqual([]);
  expect(result.namedReExports).toEqual([
    { exportedName: "f", importedName: "f", moduleSpecifier: "./inner.js" },
  ]);
});

it.each([
  [
    "lazy binders with a selector block",
    'import { createLazyRuntimeMethodBinder } from "./shared/lazy-runtime.js"; const bind = createLazyRuntimeMethodBinder(load); export const f = bind(r => { prepare(); return r.f; });',
  ],
  [
    "extra call wrappers",
    imported("export function f(...args: unknown[]) { prepare(); return impl(...args); }"),
  ],
])("keeps %s as real definitions", (_label, content) => {
  expect([...exportsOf(content, "source.ts").definitions]).toEqual(["f"]);
});

it("deduplicates overloads inside one module", () => {
  expect(
    collisions({
      "src/overloads.ts": `
    export function f(value: string): string;
    export function f(value: number): number;
    export function f(value: string | number) { return value; }
  `,
    }),
  ).toEqual([]);
});

it.each<{
  files: Record<string, string>;
  expected: ReturnType<typeof collision> & { sdk?: boolean };
}>([
  {
    files: { "src/a.js": "export const f = 1;", "src/b.mjs": "export const f = 2;" },
    expected: collision("f", "src/a.js", "src/b.mjs"),
  },
  {
    files: {
      "src/a.ts": "export const f = 1;",
      "src/b.ts": "export function f() {}",
      "src/plugin-sdk/public.ts": 'export * from "./star.js";',
      "src/plugin-sdk/star.ts": 'export * from "../../packages/public.js";',
      "packages/public.ts": "export const f = true;",
    },
    expected: { ...collision("f", "src/a.ts", "src/b.ts"), sdk: true },
  },
])("discovers repository collisions (%j)", async ({ files, expected }) => {
  await withTempDir("openclaw-export-collisions-sdk-", async (root) => {
    const fixture = fixtureFiles(root);
    for (const [file, source] of Object.entries(files)) {
      fixture.write(file, source);
    }
    expect(await collectRepositoryCollisions(root)).toEqual([expected]);
  });
});
