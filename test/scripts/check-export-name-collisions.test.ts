import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectModuleExportNames,
  collectRepositoryCollisions,
  findAliasingReExports,
  findExportNameCollisions,
  isExcludedExportCollisionSource,
} from "../../scripts/check-export-name-collisions.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string, fileName = "source.ts") {
  return [fileName, parser.parseSourceFile(fileName, content)] as const;
}

describe("export name collision guard", () => {
  it.each([
    ["src/example.test.ts", true],
    ["src/example.d.ts", true],
    ["src/test/example.ts", true],
    ["src/nested/__fixtures__/example.mts", true],
    ["src/example.ts", false],
  ])("classifies source exclusion %s", (filePath, expected) => {
    expect(isExcludedExportCollisionSource(filePath)).toBe(expected);
  });

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
          path: "src/overloads.ts",
          content: `
          export function convert(value: string): string;
          export function convert(value: number): number;
          export function convert(value: string | number) { return value; }
        `,
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

  it("exempts only the exact handoff loader substitution", () => {
    const name = "loadFreeBsdProcessIdentityNative";
    const paths = [
      "src/infra/update-managed-service-handoff-native-loader.ts",
      "src/shared/freebsd-process-identity-native.ts",
    ];
    const modules = paths.map((id) => ({ path: id, content: `export function ${name}() {}` }));
    expect(findExportNameCollisions(modules)).toEqual([]);
    const extra = { path: "src/extra.ts", content: `export function ${name}() {}` };
    expect(findExportNameCollisions([...modules, extra])).toEqual([
      { name, files: [...paths, extra.path].toSorted() },
    ]);
    expect(findExportNameCollisions([modules[0]!, extra])).toEqual([
      { name, files: [paths[0]!, extra.path].toSorted() },
    ]);
    expect(
      findExportNameCollisions(
        paths.map((id) => ({ path: id, content: "export function otherBehavior() {}" })),
      ),
    ).toEqual([{ name: "otherBehavior", files: paths }]);
  });

  it("limits worker protocol exemptions to approved modules", () => {
    const name = "bindSqliteWorkerBackend";
    const paths = [
      "src/agents/auth-profiles/inline-usage.worker.ts",
      "src/boards/sqlite-board-store.worker.ts",
    ];
    const content = `export function ${name}() {}`;
    const modules = paths.map((modulePath) => ({ path: modulePath, content }));
    expect(findExportNameCollisions(modules)).toEqual([]);
    const extra = { path: "src/unrelated/extra.worker.ts", content };
    expect(findExportNameCollisions([...modules, extra])).toEqual([
      { name, files: [...paths, extra.path].toSorted() },
    ]);
    for (const module of modules) {
      expect(findExportNameCollisions([module, extra])).toEqual([
        { name, files: [module.path, extra.path].toSorted() },
      ]);
    }
    const otherProtocol = "createSqliteWorkerBackend";
    expect(
      findExportNameCollisions(
        paths.map((modulePath) => ({
          path: modulePath,
          content: `export function ${otherProtocol}() {}`,
        })),
      ),
    ).toEqual([{ name: otherProtocol, files: paths.toSorted() }]);
  });

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

  it("distinguishes transparent forwarders from definitions", () => {
    const transparent = [
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export function resolveThing(first: string, second?: number) {
          return resolveThingImpl(first, second);
        }
      `,
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export const resolveThing = resolveThingImpl;
      `,
      `
        import { resolveThing as resolveThingImpl } from "./thing.js";
        export const resolveThing = (first: string, second?: number) =>
          resolveThingImpl(first, second);
      `,
      `
        export const runThing = async (...args: unknown[]) => {
          const runtime = await loadRuntime();
          return runtime.runThing(...args);
        };
      `,
      `
        export async function runThing(...args: unknown[]) {
          return (await loadRuntime()).runThing(...args);
        }
      `,
      `
        export async function runThing(...args: unknown[]) {
          const runtime = await loadRuntime();
          return runtime.runThing(...args);
        }
      `,
      `
        import { createLazyRuntimeMethodBinder as createBinder } from "./shared/lazy-runtime.js";
        const bind = createBinder(loadRuntime);
        export const runThing = bind((runtime) => runtime.runThing);
      `,
      `
        import { createLazyRuntimeMethod } from "openclaw/plugin-sdk/lazy-runtime";
        export const runThing = createLazyRuntimeMethod(loadRuntime, (runtime) => runtime.runThing);
      `,
    ];
    const bind = (selector: string, specifier = "./shared/lazy-runtime.js") => `
      import { createLazyRuntimeMethodBinder } from "${specifier}";
      const bind = createLazyRuntimeMethodBinder(loadRuntime);
      export const runThing = bind(${selector});
    `;
    const wrappers = [
      ["...args: unknown[]", "prepare(); return resolveThingImpl(...args);"],
      ["...args: unknown[]", "return resolveThingImpl(...args, fallback);"],
      ["first: string, second: string", "return resolveThingImpl(second, first);"],
      ["params: Record<string, unknown>", "return resolveThingImpl({ ...params, enabled: true });"],
      ["...args: unknown[]", "return ready ? resolveThingImpl(...args) : fallback;"],
    ];
    const cases: { content: string; definitions: string[] }[] = [
      ...transparent.map((content) => ({ content, definitions: [] })),
      ...[
        "runtime => runtime.otherThing",
        "runtime => runtime.runThing()",
        "runtime => other.runThing",
        "runtime => (...args) => runtime.runThing(...args, fallback)",
        "runtime => runtime.runThing, fallback",
        "(runtime = fallback) => runtime.runThing",
        "(...runtime) => runtime.runThing",
        "runtime => { prepare(); return runtime.runThing; }",
      ].map((selector) => ({ content: bind(selector), definitions: ["runThing"] })),
      { content: bind("runtime => runtime.runThing", "./unrelated.js"), definitions: ["runThing"] },
      ...wrappers.map(([params, body]) => ({
        content: `import { resolveThing as resolveThingImpl } from "./thing.js";
          export function resolveThing(${params}) { ${body} }`,
        definitions: ["resolveThing"],
      })),
      {
        content: `import { resolveThing as resolveThingImpl } from "./thing.js";
          export const resolveThing = (...args: unknown[]) => resolveThingImpl(...args, fallback);`,
        definitions: ["resolveThing"],
      },
    ];
    for (const { content, definitions } of cases) {
      expect(
        [
          ...collectModuleExportNames(...parseFixture(content, "src/runtime-facade.ts"))
            .definitions,
        ],
        content,
      ).toEqual(definitions);
    }
  });

  it.each<[string, string, boolean]>([
    [
      "function",
      'export async function runThing(first: string, second?: number) { const runtime = await import("./runtime.js"); return runtime.runThing(first, second); }',
      false,
    ],
    [
      "const arrow",
      'export const runThing = async (...args: unknown[]) => { const runtime = await import("./runtime.js"); return runtime.runThing(...args); };',
      false,
    ],
    [
      "inline import",
      'export async function runThing(...args: unknown[]) { return (await import("./runtime.js")).runThing(...args); }',
      false,
    ],
    ...(
      [
        [
          "computed import",
          "const runtime = await import(target); return runtime.runThing(...args);",
        ],
        [
          "ordinary call with an argument",
          'const runtime = await loadRuntime("./runtime.js"); return runtime.runThing(...args);',
        ],
        [
          "added argument",
          'const runtime = await import("./runtime.js"); return runtime.runThing(...args, fallback);',
        ],
        [
          "changed member",
          'const runtime = await import("./runtime.js"); return runtime.otherThing(...args);',
        ],
        [
          "extra behavior",
          'const runtime = await import("./runtime.js"); prepare(); return runtime.runThing(...args);',
        ],
        [
          "inline changed arguments",
          'return (await import("./runtime.js")).runThing(...args, fallback);',
        ],
      ] satisfies [string, string][]
    ).map(([name, body]): [string, string, boolean] => [
      name,
      `export async function runThing(...args) { ${body} }`,
      true,
    ]),
  ])("classifies %s dynamic-import forwarders", (_name, content, collision) => {
    expect(
      findExportNameCollisions([
        { path: "src/facade.ts", content },
        { path: "src/runtime.ts", content: "export function runThing() {}" },
      ]),
    ).toEqual(collision ? [{ name: "runThing", files: ["src/facade.ts", "src/runtime.ts"] }] : []);
  });

  it.each([
    [
      "untyped named alias",
      'import { runTask as runTaskInner } from "./inner.js";',
      "export const runTask = runTaskInner;",
    ],
    [
      "typed named alias",
      'import { runTask as runTaskInner } from "./inner.js";',
      "export const runTask: () => string = runTaskInner;",
    ],
    [
      "namespace property alias",
      'import * as runtime from "./inner.js";',
      "export const runTask = runtime.runTask;",
    ],
    [
      "type-asserted namespace element alias",
      'import * as runtime from "./inner.js";',
      'export const runTask = (runtime["runTask"] as () => string);',
    ],
  ])("records %s as a re-export instead of a value definition", (_name, imported, declaration) => {
    const result = collectModuleExportNames(
      ...parseFixture(`${imported}\n${declaration}`, "src/facade.ts"),
    );

    expect([...result.exportedNames]).toEqual(["runTask"]);
    expect([...result.definitions]).toEqual([]);
    expect([...result.valueDefinitions]).toEqual([]);
    expect(result.namedReExports).toEqual([
      { exportedName: "runTask", importedName: "runTask", moduleSpecifier: "./inner.js" },
    ]);
  });

  it.each<{
    name: string;
    sources: Record<string, string>;
    collisions: { name: string; files: string[]; sdk?: true }[];
  }>([
    {
      name: "JavaScript modules",
      sources: {
        "src/alpha.js": "export const sharedValue = 1;\n",
        "src/beta.mjs": "export const sharedValue = 2;\n",
      },
      collisions: [{ name: "sharedValue", files: ["src/alpha.js", "src/beta.mjs"] }],
    },
    {
      name: "package-backed SDK barrels",
      sources: {
        "src/one.ts": "export const publicCollision = 1;\n",
        "src/two.ts": "export function publicCollision() {}\n",
        "src/plugin-sdk/public.ts": 'export * from "./public-star.js";\n',
        "src/plugin-sdk/public-star.ts": 'export * from "../../packages/public.js";\n',
        "packages/public.ts": "export const publicCollision = true;\n",
      },
      collisions: [{ name: "publicCollision", files: ["src/one.ts", "src/two.ts"], sdk: true }],
    },
  ])("discovers collisions in $name", async ({ sources, collisions }) => {
    await withTempDir("openclaw-export-collisions-", async (repoRoot) => {
      for (const [file, content] of Object.entries(sources)) {
        const target = path.join(repoRoot, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      expect(await collectRepositoryCollisions(repoRoot)).toEqual(collisions);
    });
  });

  it("marks only collisions reachable through shared and cyclic SDK barrels", () => {
    const definitions = "export const cycleOnly = 1, extraOnly = 1, privateOnly = 1;";
    expect(
      findExportNameCollisions([
        { path: "src/one.ts", content: definitions },
        { path: "src/two.ts", content: definitions },
        {
          path: "src/plugin-sdk/first.ts",
          content:
            'export * from "../../packages/left.js"; export * from "../../packages/right.js";',
        },
        {
          path: "src/plugin-sdk/second.ts",
          content:
            'export * from "../../packages/right.js"; export * from "../../packages/extra.js";',
        },
        ...(
          [
            ["packages/left.ts", 'export * from "./shared.js";'],
            ["packages/right.ts", 'export * from "./shared.js";'],
            ["packages/shared.ts", 'export * from "./left.js"; export const cycleOnly = 1;'],
            ["packages/extra.ts", "export const extraOnly = 1;"],
            ["packages/unreachable.ts", "export const privateOnly = 1;"],
          ] as const
        ).map(([modulePath, content]) => ({
          path: modulePath,
          content,
          includeDefinitions: false,
        })),
      ]),
    ).toEqual([
      { name: "cycleOnly", files: ["src/one.ts", "src/two.ts"], sdk: true },
      { name: "extraOnly", files: ["src/one.ts", "src/two.ts"], sdk: true },
      { name: "privateOnly", files: ["src/one.ts", "src/two.ts"] },
    ]);
  });
});
