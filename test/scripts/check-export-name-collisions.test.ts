import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  collectModuleExportNames,
  collectRepositoryCollisions,
  findAliasingReExports,
  findExportNameCollisions,
} from "../../scripts/check-export-name-collisions.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function exportsOf(content: string, fileName = "source.ts") {
  return collectModuleExportNames(fileName, parser.parseSourceFile(fileName, content));
}

function definitions(content: string, fileName = "src/runtime-facade.ts") {
  return [...exportsOf(content, fileName).definitions];
}

function sources(files: Record<string, string>) {
  return Object.entries(files).map(([file, content]) => ({ path: file, content }));
}

function collisions(files: Record<string, string>) {
  return findExportNameCollisions(sources(files));
}

it("finds exported function and const definitions across modules", () => {
  expect(
    collisions({
      "src/alpha.ts": "export function sharedBehavior() {}",
      "src/beta.ts": "export const sharedBehavior = () => {};",
      "src/gamma.ts": "async function listedBehavior() {}\nexport { listedBehavior };",
      "src/delta.mts": "export async function listedBehavior() {}",
    }),
  ).toEqual([
    { name: "listedBehavior", files: ["src/delta.mts", "src/gamma.ts"] },
    { name: "sharedBehavior", files: ["src/alpha.ts", "src/beta.ts"] },
  ]);
});

it("ignores types, pure re-exports, imports exported locally, and renamed exports", () => {
  const result = exportsOf(`
      import { importedValue } from "./other.js";
      interface LocalShape {}
      type LocalType = string;
      export { importedValue };
      export { remoteValue } from "./remote.js";
      export { remoteValue as renamedValue } from "./remote.js";
      export * from "./barrel.js";
      export interface ExportedShape {}
      export type ExportedType = string;
    `);
  expect([...result.definitions]).toEqual([]);
  expect([...result.exportedNames]).toEqual(["importedValue", "remoteValue"]);
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
] as const)(
  "limits %s exemptions to the exact approved modules",
  (name, other, extraPath, paths) => {
    const content = `export function ${name}() {}`;
    const modules = paths.map((modulePath) => ({ path: modulePath, content }));
    expect(findExportNameCollisions(modules)).toEqual([]);

    const extra = { path: extraPath, content };
    expect(findExportNameCollisions([...modules, extra])).toEqual([
      { name, files: [...paths, extra.path].toSorted() },
    ]);
    for (const module of modules) {
      expect(findExportNameCollisions([module, extra])).toEqual([
        { name, files: [module.path, extra.path].toSorted() },
      ]);
    }
    expect(
      findExportNameCollisions(
        paths.map((modulePath) => ({
          path: modulePath,
          content: `export function ${other}() {}`,
        })),
      ),
    ).toEqual([{ name: other, files: paths.toSorted() }]);
  },
);

it("reports direct aliasing re-exports only outside the Plugin SDK", () => {
  expect(
    findAliasingReExports([
      ...sources({
        "src/alias.ts": `
            export { original } from "./source.js";
            export type { OriginalType as RenamedType } from "./source.js";
            export { original as renamed } from "./source.js";
          `,
        "src/local-alias.ts": `
            import { original } from "./source.js";
            export { original as locallyRenamed };
          `,
        "src/plugin-sdk/alias.ts": 'export { original as sanctioned } from "../source.js";',
      }),
      {
        path: "packages/support.ts",
        content: 'export { original as packageAlias } from "./source.js";',
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

it("exempts exact function and const same-name forwarders", () => {
  const imported = (body: string) => `import { f as impl } from "./f.js"; ${body}`;
  const runtime = (body: string) => `export async function f(...args: unknown[]) { ${body} }`;
  const forwarders = [
    imported("export function f(a: string, b?: number) { return impl(a, b); }"),
    imported("export const f = impl;"),
    imported("export const f = (a: string, b?: number) => impl(a, b);"),
    "export const f = async (...args: unknown[]) => { const r = await load(); return r.f(...args); };",
    runtime("return (await load()).f(...args);"),
    runtime("const r = await load(); return r.f(...args);"),
    'import { createLazyRuntimeMethodBinder as bind } from "./shared/lazy-runtime.js"; const b = bind(load); export const f = b((r) => r.f);',
    'import { createLazyRuntimeMethod } from "openclaw/plugin-sdk/lazy-runtime"; export const f = createLazyRuntimeMethod(load, (r) => r.f);',
  ];
  for (const content of forwarders) {
    expect(definitions(content)).toEqual([]);
  }
});

it.each([
  ["computed import", "const r = await import(target); return r.f(...args);"],
  ["added argument", 'const r = await import("./runtime.js"); return r.f(...args, fallback);'],
  ["changed member", 'const r = await import("./runtime.js"); return r.other(...args);'],
])("keeps a dynamic-import wrapper with %s as a collision", (_name, body) => {
  expect(
    collisions({
      "src/facade.ts": `export async function f(...args) { ${body} }`,
      "src/runtime.ts": "export function f() {}",
    }),
  ).toEqual([{ name: "f", files: ["src/facade.ts", "src/runtime.ts"] }]);
});

it("records a type-asserted namespace element alias as a re-export instead of a value definition", () => {
  const result = exportsOf(
    'import * as runtime from "./inner.js";\nexport const runTask = (runtime["runTask"] as () => string);',
    "src/facade.ts",
  );

  expect([...result.exportedNames]).toEqual(["runTask"]);
  expect([...result.definitions]).toEqual([]);
  expect([...result.valueDefinitions]).toEqual([]);
  expect(result.namedReExports).toEqual([
    { exportedName: "runTask", importedName: "runTask", moduleSpecifier: "./inner.js" },
  ]);
});

it.each([
  [
    "lazy binders with a selector block",
    "runThing",
    `
      import { createLazyRuntimeMethodBinder } from "./shared/lazy-runtime.js";
      const bind = createLazyRuntimeMethodBinder(loadRuntime);
      export const runThing = bind(runtime => { prepare(); return runtime.runThing; });
    `,
  ],
  [
    "extra call wrappers",
    "resolveThing",
    `
      import { resolveThing as resolveThingImpl } from "./thing.js";
      export function resolveThing(...args: unknown[]) {
        prepare();
        return resolveThingImpl(...args);
      }
    `,
  ],
])("keeps %s as real definitions", (_label, name, content) => {
  expect(definitions(content, "source.ts")).toEqual([name]);
});

it("deduplicates overloads inside one module", () => {
  expect(
    collisions({
      "src/overloads.ts": `
            export function convert(value: string): string;
            export function convert(value: number): number;
            export function convert(value: string | number) { return value; }
          `,
    }),
  ).toEqual([]);
});

it.each<{
  files: Record<string, string>;
  expected: { name: string; files: string[]; sdk?: boolean };
}>([
  {
    files: {
      "src/alpha.js": "export const sharedValue = 1;\n",
      "src/beta.mjs": "export const sharedValue = 2;\n",
    },
    expected: { name: "sharedValue", files: ["src/alpha.js", "src/beta.mjs"] },
  },
  {
    files: {
      "src/one.ts": "export const publicCollision = 1;\n",
      "src/two.ts": "export function publicCollision() {}\n",
      "src/plugin-sdk/public.ts": 'export * from "./public-star.js";\n',
      "src/plugin-sdk/public-star.ts": 'export * from "../../packages/public.js";\n',
      "packages/public.ts": "export const publicCollision = true;\n",
    },
    expected: { name: "publicCollision", files: ["src/one.ts", "src/two.ts"], sdk: true },
  },
])("discovers $expected.name collisions", async ({ files, expected }) => {
  await withTempDir("openclaw-export-collisions-sdk-", async (repoRoot) => {
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(repoRoot, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
    }
    expect(await collectRepositoryCollisions(repoRoot)).toEqual([expected]);
  });
});
