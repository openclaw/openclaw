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
  it.each([["src/example.ts", false]])("classifies source exclusion %s", (filePath, expected) => {
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

  it("exempts only the exact sealed recovery loader substitutions", () => {
    const name = "loadFreeBsdProcessIdentityNative";
    const paths = [
      "src/infra/package-update-activation-native-loader.ts",
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

  it.each([
    {
      name: "openExistingSqliteWorkerBackend",
      paths: ["src/state/openclaw-state.worker.ts", "src/state/openclaw-agent-execution.worker.ts"],
    },
  ])("limits $name to its approved worker modules", ({ name, paths }) => {
    const content = `export function ${name}() {}`;
    const modules = paths.map((modulePath) => ({ path: modulePath, content }));
    expect(findExportNameCollisions(modules)).toEqual([]);
    for (const [index, module] of modules.entries()) {
      for (const sibling of modules.slice(index + 1)) {
        expect(findExportNameCollisions([module, sibling])).toEqual([]);
      }
    }

    const extra = { path: "src/unrelated/extra.worker.ts", content };
    expect(findExportNameCollisions([...modules, extra])).toEqual([
      { name, files: [...paths, extra.path].toSorted() },
    ]);
    for (const module of modules) {
      expect(findExportNameCollisions([module, extra])).toEqual([
        { name, files: [module.path, extra.path].toSorted() },
      ]);
    }
    const otherProtocol =
      name === "bindSqliteWorkerBackend" ? "createSqliteWorkerBackend" : "bindSqliteWorkerBackend";
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

  it("exempts exact function and const same-name forwarders", () => {
    const forwarders = [
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
    for (const content of forwarders) {
      expect([
        ...collectModuleExportNames(...parseFixture(content, "src/runtime-facade.ts")).definitions,
      ]).toEqual([]);
    }
  });

  it.each([
    [
      "const arrow",
      `export const runThing = async (...args: unknown[]) => {
        const runtime = await import("./runtime.js");
        return runtime.runThing(...args);
      };`,
    ],
  ])("does not duplicate a literal-import %s forwarder", (_name, content) => {
    expect(
      findExportNameCollisions([
        { path: "src/facade.ts", content },
        { path: "src/runtime.ts", content: "export function runThing() {}" },
      ]),
    ).toEqual([]);
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

  it.each([
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

  it.each([["selector block", "runtime => { prepare(); return runtime.runThing; }"]])(
    "keeps lazy binders with %s as definitions",
    (_name, selector) => {
      const content = `
      import { createLazyRuntimeMethodBinder } from "./shared/lazy-runtime.js";
      const bind = createLazyRuntimeMethodBinder(loadRuntime);
      export const runThing = bind(${selector});
    `;
      expect([
        ...collectModuleExportNames(...parseFixture(content, "src/runtime-facade.ts")).definitions,
      ]).toEqual(["runThing"]);
    },
  );

  it.each([
    {
      name: "extra call",
      body: `
        prepare();
        return resolveThingImpl(...args);
      `,
    },
  ])("keeps $name wrappers as real definitions", ({ body }) => {
    const result = collectModuleExportNames(
      ...parseFixture(`
      import { resolveThing as resolveThingImpl } from "./thing.js";
      export function resolveThing(...args: unknown[]) {
        ${body}
      }
    `),
    );
    expect([...result.definitions]).toEqual(["resolveThing"]);
  });

  it("discovers JavaScript source collisions", async () => {
    await withTempDir("openclaw-export-collisions-", async (repoRoot) => {
      const sourceRoot = path.join(repoRoot, "src");
      await fs.mkdir(sourceRoot);
      await Promise.all([
        fs.writeFile(path.join(sourceRoot, "alpha.js"), "export const sharedValue = 1;\n"),
        fs.writeFile(path.join(sourceRoot, "beta.mjs"), "export const sharedValue = 2;\n"),
      ]);
      expect(await collectRepositoryCollisions(repoRoot)).toEqual([
        { name: "sharedValue", files: ["src/alpha.js", "src/beta.mjs"] },
      ]);
    });
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

  it("marks repository collisions exposed through a package-backed Plugin SDK module", async () => {
    await withTempDir("openclaw-export-collisions-sdk-", async (repoRoot) => {
      await Promise.all([
        fs.mkdir(path.join(repoRoot, "src/plugin-sdk"), { recursive: true }),
        fs.mkdir(path.join(repoRoot, "packages"), { recursive: true }),
      ]);
      await Promise.all([
        fs.writeFile(path.join(repoRoot, "src/one.ts"), "export const publicCollision = 1;\n"),
        fs.writeFile(path.join(repoRoot, "src/two.ts"), "export function publicCollision() {}\n"),
        fs.writeFile(
          path.join(repoRoot, "src/plugin-sdk/public.ts"),
          'export * from "./public-star.js";\n',
        ),
        fs.writeFile(
          path.join(repoRoot, "src/plugin-sdk/public-star.ts"),
          'export * from "../../packages/public.js";\n',
        ),
        fs.writeFile(
          path.join(repoRoot, "packages/public.ts"),
          "export const publicCollision = true;\n",
        ),
      ]);

      expect(await collectRepositoryCollisions(repoRoot)).toEqual([
        {
          name: "publicCollision",
          files: ["src/one.ts", "src/two.ts"],
          sdk: true,
        },
      ]);
    });
  });
});
