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

function parseFixture(content: string, fileName = "source.ts") {
  return [fileName, parser.parseSourceFile(fileName, content)] as const;
}

function definitions(content: string, fileName = "src/runtime-facade.ts") {
  return [...collectModuleExportNames(...parseFixture(content, fileName)).definitions];
}

async function writeSources(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([file, source]) => {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
    }),
  );
}

it("finds exported function and const definitions across modules", () => {
  expect(
    findExportNameCollisions([
      { path: "src/alpha.ts", content: "export function sharedBehavior() {}" },
      { path: "src/beta.ts", content: "export const sharedBehavior = () => {};" },
      {
        path: "src/gamma.ts",
        content: "async function listedBehavior() {}\nexport { listedBehavior };",
      },
      {
        path: "src/delta.mts",
        content: "export async function listedBehavior() {}",
      },
    ]),
  ).toEqual([
    { name: "listedBehavior", files: ["src/delta.mts", "src/gamma.ts"] },
    { name: "sharedBehavior", files: ["src/alpha.ts", "src/beta.ts"] },
  ]);
});

it("ignores types, pure re-exports, imports exported locally, and renamed exports", () => {
  const result = collectModuleExportNames(
    ...parseFixture(`
      import { importedValue } from "./other.js";
      interface LocalShape {}
      type LocalType = string;
      export { importedValue };
      export { remoteValue } from "./remote.js";
      export { remoteValue as renamedValue } from "./remote.js";
      export * from "./barrel.js";
      export interface ExportedShape {}
      export type ExportedType = string;
    `),
  );
  expect([...result.definitions]).toEqual([]);
  expect([...result.exportedNames]).toEqual(["importedValue", "remoteValue"]);
});

it.each([
  {
    name: "loadFreeBsdProcessIdentityNative",
    other: "otherBehavior",
    extra: "src/extra.ts",
    paths: [
      "src/infra/package-update-activation-native-loader.ts",
      "src/infra/update-managed-service-handoff-native-loader.ts",
      "src/shared/freebsd-process-identity-native.ts",
    ],
  },
  {
    name: "openExistingSqliteWorkerBackend",
    other: "bindSqliteWorkerBackend",
    extra: "src/unrelated/extra.worker.ts",
    paths: ["src/state/openclaw-state.worker.ts", "src/state/openclaw-agent-execution.worker.ts"],
  },
])(
  "limits $name exemptions to the exact approved modules",
  ({ name, other, extra: extraPath, paths }) => {
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
      {
        path: "src/alias.ts",
        content: `
            export { original } from "./source.js";
            export type { OriginalType as RenamedType } from "./source.js";
            export { original as renamed } from "./source.js";
          `,
      },
      {
        path: "src/local-alias.ts",
        content: `
            import { original } from "./source.js";
            export { original as locallyRenamed };
          `,
      },
      {
        path: "src/plugin-sdk/alias.ts",
        content: 'export { original as sanctioned } from "../source.js";',
      },
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
  const imported = (declaration: string) =>
    `import { resolveThing as resolveThingImpl } from "./thing.js"; ${declaration}`;
  const runtimeFunction = (body: string) =>
    `export async function runThing(...args: unknown[]) { ${body} }`;
  const forwarders = [
    imported(
      "export function resolveThing(first: string, second?: number) { return resolveThingImpl(first, second); }",
    ),
    imported("export const resolveThing = resolveThingImpl;"),
    imported(
      "export const resolveThing = (first: string, second?: number) => resolveThingImpl(first, second);",
    ),
    "export const runThing = async (...args: unknown[]) => { const runtime = await loadRuntime(); return runtime.runThing(...args); };",
    runtimeFunction("return (await loadRuntime()).runThing(...args);"),
    runtimeFunction("const runtime = await loadRuntime(); return runtime.runThing(...args);"),
    'import { createLazyRuntimeMethodBinder as createBinder } from "./shared/lazy-runtime.js"; const bind = createBinder(loadRuntime); export const runThing = bind((runtime) => runtime.runThing);',
    'import { createLazyRuntimeMethod } from "openclaw/plugin-sdk/lazy-runtime"; export const runThing = createLazyRuntimeMethod(loadRuntime, (runtime) => runtime.runThing);',
  ];
  for (const content of forwarders) {
    expect(definitions(content)).toEqual([]);
  }
});

it.each([
  ["computed import", "const runtime = await import(target); return runtime.runThing(...args);"],
  [
    "added argument",
    'const runtime = await import("./runtime.js"); return runtime.runThing(...args, fallback);',
  ],
  [
    "changed member",
    'const runtime = await import("./runtime.js"); return runtime.otherThing(...args);',
  ],
])("keeps a dynamic-import wrapper with %s as a collision", (_name, body) => {
  expect(
    findExportNameCollisions([
      { path: "src/facade.ts", content: `export async function runThing(...args) { ${body} }` },
      { path: "src/runtime.ts", content: "export function runThing() {}" },
    ]),
  ).toEqual([{ name: "runThing", files: ["src/facade.ts", "src/runtime.ts"] }]);
});

it("records a type-asserted namespace element alias as a re-export instead of a value definition", () => {
  const result = collectModuleExportNames(
    ...parseFixture(
      'import * as runtime from "./inner.js";\nexport const runTask = (runtime["runTask"] as () => string);',
      "src/facade.ts",
    ),
  );

  expect([...result.exportedNames]).toEqual(["runTask"]);
  expect([...result.definitions]).toEqual([]);
  expect([...result.valueDefinitions]).toEqual([]);
  expect(result.namedReExports).toEqual([
    { exportedName: "runTask", importedName: "runTask", moduleSpecifier: "./inner.js" },
  ]);
});

it("keeps lazy binders with a selector block as definitions", () => {
  const content = `
      import { createLazyRuntimeMethodBinder } from "./shared/lazy-runtime.js";
      const bind = createLazyRuntimeMethodBinder(loadRuntime);
      export const runThing = bind(runtime => { prepare(); return runtime.runThing; });
    `;
  expect(definitions(content)).toEqual(["runThing"]);
});

it("keeps extra call wrappers as real definitions", () => {
  expect(
    definitions(
      `
      import { resolveThing as resolveThingImpl } from "./thing.js";
      export function resolveThing(...args: unknown[]) {
        prepare();
        return resolveThingImpl(...args);
      }
    `,
      "source.ts",
    ),
  ).toEqual(["resolveThing"]);
});

it("deduplicates overloads inside one module", () => {
  expect(
    findExportNameCollisions([
      {
        path: "src/overloads.ts",
        content: `
            export function convert(value: string): string;
            export function convert(value: number): number;
            export function convert(value: string | number) { return value; }
          `,
      },
    ]),
  ).toEqual([]);
});

it.each<{
  name: string;
  files: Record<string, string>;
  expected: { name: string; files: string[]; sdk?: boolean };
}>([
  {
    name: "JavaScript sources",
    files: {
      "src/alpha.js": "export const sharedValue = 1;\n",
      "src/beta.mjs": "export const sharedValue = 2;\n",
    },
    expected: { name: "sharedValue", files: ["src/alpha.js", "src/beta.mjs"] },
  },
  {
    name: "package-backed Plugin SDK",
    files: {
      "src/one.ts": "export const publicCollision = 1;\n",
      "src/two.ts": "export function publicCollision() {}\n",
      "src/plugin-sdk/public.ts": 'export * from "./public-star.js";\n',
      "src/plugin-sdk/public-star.ts": 'export * from "../../packages/public.js";\n',
      "packages/public.ts": "export const publicCollision = true;\n",
    },
    expected: { name: "publicCollision", files: ["src/one.ts", "src/two.ts"], sdk: true },
  },
])("discovers collisions through $name", async ({ files, expected }) => {
  await withTempDir("openclaw-export-collisions-sdk-", async (repoRoot) => {
    await writeSources(repoRoot, files);
    expect(await collectRepositoryCollisions(repoRoot)).toEqual([expected]);
  });
});
