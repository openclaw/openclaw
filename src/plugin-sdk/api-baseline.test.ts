/**
 * Tests the plugin SDK public API baseline.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import { Program } from "typescript/unstable/async";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeTypeScript from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeclarationClosureRenderer } from "./api-baseline-declaration-closure.js";
import { formatPluginSdkApiTypeAlias } from "./api-baseline-declaration-print.js";
import {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
  renderPluginSdkApiBaseline,
  type PluginSdkApiBaseline,
} from "./api-baseline.js";
import {
  diffPluginSdkApi,
  formatPluginSdkApiDiffReport,
  hasPluginSdkApiChanges,
  parsePluginSdkApiDiffSurface,
  pluginSdkApiAcknowledgement,
  readPluginSdkApiEntrypoints,
  type PluginSdkApiDiff,
} from "./api-diff.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function renderSourceFixture(
  files: Readonly<Record<string, string>>,
  entrypoints: readonly string[] = ["fixture"],
) {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
      },
    })}\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return renderPluginSdkApiBaseline({ repoRoot, entrypoints });
}

function writePluginSdkInventory(repoRoot: string, entrypoints: readonly string[]): void {
  const inventoryDir = path.join(repoRoot, "scripts", "lib");
  fs.mkdirSync(inventoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(inventoryDir, "plugin-sdk-entrypoints.json"),
    `${JSON.stringify(entrypoints)}\n`,
  );
  fs.writeFileSync(
    path.join(inventoryDir, "plugin-sdk-private-local-only-subpaths.json"),
    '["private-fixture"]\n',
  );
}

async function renderPrivateDeclarationFixture(params?: {
  comments?: boolean;
  optionalOption?: boolean;
  optionalResult?: boolean;
}) {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  const externalDir = path.join(repoRoot, "node_modules", "fixture-external");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture.ts"),
    [
      'import type { FixtureOptionLeaf } from "./fixture-option.js";',
      'import type { FixtureResultLeaf } from "./fixture-result.js";',
      `${params?.comments ? "/** Options docs */ " : ""}type FixtureOptions = { nested: FixtureOptionLeaf };`,
      "type FixtureResult = { nested: FixtureResultLeaf };",
      "export declare function createFixture(options: FixtureOptions): FixtureResult;",
      `${params?.comments ? "/** Error docs */ " : ""}export class FixtureError extends Error {`,
      "  readonly status: number;",
      '  constructor(status: number) { super("fixture"); this.status = status; }',
      "  getStatus() { return this.status; }",
      "}",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-option.ts"),
    [
      'import type { FixtureResultLeaf } from "./fixture-result.js";',
      'import type { FixtureExternal } from "fixture-external";',
      `export type FixtureOptionLeaf = { required${params?.optionalOption ? "?" : ""}: string; result?: FixtureResultLeaf; external?: FixtureExternal };`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-result.ts"),
    'export type { FixtureResultLeaf } from "./fixture-result-shape.js";\n',
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture-result-shape.ts"),
    [
      'import type { FixtureOptionLeaf } from "./fixture-option.js";',
      `export type FixtureResultLeaf = { value${params?.optionalResult ? "?" : ""}: string; option?: FixtureOptionLeaf };`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(externalDir, "package.json"),
    `${JSON.stringify({ name: "fixture-external", types: "index.d.ts" })}\n`,
  );
  fs.writeFileSync(
    path.join(externalDir, "index.d.ts"),
    "export type FixtureExternal = { externalOnly: string };\n",
  );
  return renderPluginSdkApiBaseline({ repoRoot, entrypoints: ["fixture"] });
}

async function renderDependencyDeclarationFixture(dependencyDeclaration: string) {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-dependency-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  const dependencyDir = path.join(repoRoot, "node_modules", "fixture-dependency");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(dependencyDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ESNext",
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(sourceDir, "fixture.ts"),
    'import { fixtureValue } from "fixture-dependency";\nexport const publicValue = fixtureValue;\n',
  );
  fs.writeFileSync(
    path.join(dependencyDir, "package.json"),
    '{"name":"fixture-dependency","type":"module","types":"index.d.ts"}\n',
  );
  fs.writeFileSync(path.join(dependencyDir, "index.d.ts"), dependencyDeclaration);
  return renderPluginSdkApiBaseline({ repoRoot, entrypoints: ["fixture"] });
}

function createTupleAliasFixture(tuple: string, warmup: string, prewarm: boolean) {
  const cwd = tempDirs.make("openclaw-plugin-sdk-tuple-");
  const fileName = path.join(cwd, "fixture.ts");
  const configFileName = path.join(cwd, "tsconfig.json");
  const source = [
    "interface Array<T> { [index: number]: T; readonly length: number }",
    "interface ReadonlyArray<T> { readonly [index: number]: T; readonly length: number }",
    `type Warmup = ${warmup};`,
    `const VALUES = ${tuple};`,
    "type Value = (typeof VALUES)[number];",
  ].join("\n");
  const native = nativeTypeScript.createNativeTypeScriptProject({
    cwd,
    configFileName,
    files: {
      [fileName]: source,
      [configFileName]: JSON.stringify({
        compilerOptions: { noLib: true, target: "esnext", types: [] },
        files: [fileName],
      }),
    },
  });
  const { checker } = native.project;
  const sourceFile = native.project.program.getSourceFile(fileName);
  if (!sourceFile) {
    native.close();
    throw new Error("Missing tuple fixture source");
  }
  const [warmupAlias, declaration] = sourceFile.statements.filter(ts.isTypeAliasDeclaration);
  if (!warmupAlias || !declaration) {
    native.close();
    throw new Error("Missing tuple fixture type aliases");
  }
  if (prewarm) {
    checker.getTypeAtLocation(warmupAlias);
  }
  return { checker, declaration, [Symbol.dispose]: native.close };
}

describe("Plugin SDK API baseline", () => {
  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "agent-model-discovery");
    const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain('import("<repo>", { with: { "resolution-mode": "import" } })');
    expect(
      normalizePluginSdkApiDeclarationText(
        repoRoot,
        'type Owned = import("src/x").Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("src/x"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
      ),
    ).toBe(
      'type Owned = Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("<repo>"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
    );
  });

  it("normalizes dependency source paths to stable node_modules paths", () => {
    const repoRoot = path.join(path.sep, "workspace", "openclaw-worktree");
    const linkedDependencyPath = path.join(
      path.sep,
      "workspace",
      "openclaw",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );
    const pnpmDependencyPath = path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "@openclaw+fs-safe@1.0.0",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );

    expect(normalizePluginSdkApiSourcePath(repoRoot, linkedDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
    expect(normalizePluginSdkApiSourcePath(repoRoot, pnpmDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
  });

  it("keeps repo source paths relative when a parent directory is named node_modules", () => {
    const repoRoot = path.join(path.sep, "workspace", "node_modules", "openclaw");
    const sourcePath = path.join(repoRoot, "src", "plugin-sdk", "core.ts");

    expect(normalizePluginSdkApiSourcePath(repoRoot, sourcePath)).toBe("src/plugin-sdk/core.ts");
  });

  it.each([
    {
      tuple: '["first", "middle", "last", "first"] as const',
      warmup: '"last"',
      expected: '"first" | "middle" | "last"',
    },
    {
      tuple: "[3, 1, 2] as const",
      warmup: "1",
      expected: "3 | 1 | 2",
    },
  ])("keeps tuple-derived unions stable across unrelated type discovery", (fixture) => {
    using baseline = createTupleAliasFixture(fixture.tuple, fixture.warmup, false);
    using prewarmed = createTupleAliasFixture(fixture.tuple, fixture.warmup, true);
    expect(formatPluginSdkApiTypeAlias(baseline.checker, baseline.declaration)).toBe(
      fixture.expected,
    );
    expect(formatPluginSdkApiTypeAlias(prewarmed.checker, prewarmed.declaration)).toBe(
      fixture.expected,
    );
  });

  it("preserves empty tuple defaults in public function signatures", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": 'export { emptyDefault as publicEmptyDefault } from "./functions.js";\n',
      "functions.ts":
        "export declare function emptyDefault<const T extends readonly string[] = []>(value?: T): T;\n",
    });

    expect(baseline.modules[0]?.exports).toEqual([
      expect.objectContaining({
        exportName: "publicEmptyDefault",
        declaration: expect.stringMatching(
          /export function publicEmptyDefault<const T extends readonly string\[\] = \[\s*\]>\(value\?: T\): T;/u,
        ),
      }),
    ]);
  });

  it("reports same-entrypoint closure changes without a committed merge unit", async () => {
    const render = (optionsExtra: string, resultExtra: string) =>
      renderSourceFixture({
        "fixture.ts": [
          `type SendOptions = { text: string${optionsExtra} };`,
          `type SendResult = { ok: boolean${resultExtra} };`,
          "export declare function send(options: SendOptions): SendResult;",
        ].join("\n"),
      });
    const baseline = await render("", "");
    const optionsChanged = await render("; accountId: string", "");
    const resultChanged = await render("", "; traceId: string");
    const combined = await render("; accountId: string", "; traceId: string");

    const conflictDir = tempDirs.make("openclaw-plugin-sdk-api-conflict-");
    const basePath = path.join(conflictDir, "base.json");
    const optionsPath = path.join(conflictDir, "options.json");
    const resultPath = path.join(conflictDir, "result.json");
    fs.writeFileSync(basePath, '{"contentHash":"base","entrypoint":"fixture"}\n');
    fs.writeFileSync(optionsPath, '{"contentHash":"options","entrypoint":"fixture"}\n');
    fs.writeFileSync(resultPath, '{"contentHash":"result","entrypoint":"fixture"}\n');
    const oldRepresentationMerge = spawnSync(
      "git",
      ["merge-file", "-p", optionsPath, basePath, resultPath],
      { encoding: "utf8" },
    );
    expect(oldRepresentationMerge.status).toBe(1);
    expect(oldRepresentationMerge.stdout).toContain("<<<<<<<");

    for (const changed of [optionsChanged, resultChanged]) {
      const diff = diffPluginSdkApi(baseline, changed);
      expect(diff.exports).toEqual([
        expect.objectContaining({
          change: "reachable",
          entrypoint: "fixture",
          exportName: "send",
        }),
      ]);
    }
    const combinedDiff = diffPluginSdkApi(baseline, combined);
    expect(
      combinedDiff.exports.flatMap((change) =>
        change.declarationChanges.map((declaration) => declaration.name),
      ),
    ).toEqual(expect.arrayContaining(["SendOptions", "SendResult"]));
    expect(hasPluginSdkApiChanges(combinedDiff)).toBe(true);
    expect(pluginSdkApiAcknowledgement(combinedDiff)).toMatch(/^[a-f0-9]{8}$/u);
    expect(
      formatPluginSdkApiDiffReport({
        baseLabel: "base",
        diff: combinedDiff,
        headLabel: "head",
      }),
    ).toContain("Reachable declarations changed");
  });

  it("reads added and removed entrypoints from each revision's own inventory", async () => {
    const baseRoot = tempDirs.make("openclaw-plugin-sdk-api-base-");
    const headRoot = tempDirs.make("openclaw-plugin-sdk-api-head-");
    writePluginSdkInventory(baseRoot, ["fixture", "private-fixture"]);
    writePluginSdkInventory(headRoot, ["fixture", "added", "private-fixture"]);

    expect(await readPluginSdkApiEntrypoints(baseRoot)).toEqual(["fixture"]);
    expect(await readPluginSdkApiEntrypoints(headRoot)).toEqual(["fixture", "added"]);

    const before = await renderSourceFixture({
      "fixture.ts": "export type Fixture = string;\n",
    });
    const renderAdded = (valueType: "number" | "string") =>
      renderSourceFixture(
        {
          "added.ts": [
            `type AddedShape = { value: ${valueType} };`,
            "export declare function createAdded(input: AddedShape): AddedShape;",
          ].join("\n"),
          "fixture.ts": "export type Fixture = string;\n",
        },
        ["fixture", "added"],
      );
    const after = await renderAdded("number");
    const sameNamesDifferentContents = await renderAdded("string");
    const addedDiff = diffPluginSdkApi(before, after);
    const removedDiff = diffPluginSdkApi(after, before);
    expect(addedDiff.entrypointsAdded).toEqual([
      {
        entrypoint: "added",
        exportNames: ["createAdded"],
        importSpecifier: "openclaw/plugin-sdk/added",
      },
    ]);
    expect(addedDiff.exports).toEqual([
      expect.objectContaining({
        change: "added",
        declarationChanges: expect.arrayContaining([
          expect.objectContaining({ after: expect.stringContaining("value: number") }),
        ]),
        entrypoint: "added",
        exportName: "createAdded",
      }),
    ]);
    expect(removedDiff.exports[0]).toMatchObject({
      change: "removed",
      declarationChanges: expect.arrayContaining([
        expect.objectContaining({ before: expect.stringContaining("value: number") }),
      ]),
    });
    expect(addedDiff.digest).not.toBe(diffPluginSdkApi(before, sameNamesDifferentContents).digest);
    expect(
      formatPluginSdkApiDiffReport({ baseLabel: "base", diff: addedDiff, headLabel: "head" }),
    ).toContain("value: number");
  });

  it("classifies exported signature changes separately from reachable-only changes", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": [
        "export interface SendOptions { text: string }",
        "export declare function send(options: SendOptions): void;",
      ].join("\n"),
    });
    const changed = await renderSourceFixture({
      "fixture.ts": [
        "export interface SendOptions { text: string; accountId: string }",
        "export declare function send(options: SendOptions): void;",
      ].join("\n"),
    });

    const diff = diffPluginSdkApi(baseline, changed);
    expect(diff.exports).toEqual([
      expect.objectContaining({ change: "signature", exportName: "SendOptions" }),
      expect.objectContaining({ change: "reachable", exportName: "send" }),
    ]);
    expect(diff.exports[0]?.declarationChanges.length).toBeGreaterThan(0);
    expect(diff.exports[1]?.declarationChanges).toEqual([]);
  });

  it("stores shared declaration detail once while retaining every affected export", async () => {
    const render = (field: string) =>
      renderSourceFixture(
        {
          "fixture.ts": [
            `type SharedOptions = { ${field}: string };`,
            "export declare function preview(options: SharedOptions): void;",
            "export declare function send(options: SharedOptions): void;",
          ].join("\n"),
          "pool-a.ts": [
            "type PoolOptions = { value: string };",
            "export declare function fixed(options: PoolOptions): void;",
          ].join("\n"),
          "pool-b.ts": [
            "type PoolOptions = { value: number };",
            "export declare function fixed(options: PoolOptions): void;",
          ].join("\n"),
        },
        ["pool-b", "fixture", "pool-a"],
      );
    const baseline = await render("text");
    const changed = await render("accountId");

    for (const [surface, field] of [
      [baseline, "text"],
      [changed, "accountId"],
    ] as const) {
      expect(surface.declarationSections.map(({ name, text }) => [name, text])).toEqual([
        ["PoolOptions", expect.stringContaining("value: number;")],
        ["PoolOptions", expect.stringContaining("value: string;")],
        ["SharedOptions", expect.stringContaining(`${field}: string;`)],
        ["fixed", expect.stringContaining("function fixed(options: PoolOptions): void;")],
        ["preview", expect.stringContaining("function preview(options: SharedOptions): void;")],
        ["send", expect.stringContaining("function send(options: SharedOptions): void;")],
      ]);
      expect(
        surface.modules.flatMap(({ entrypoint, exports }) =>
          exports.map(({ exportName, closureSectionIds }) => [
            entrypoint,
            exportName,
            closureSectionIds,
          ]),
        ),
      ).toEqual([
        ["fixture", "preview", [2, 4]],
        ["fixture", "send", [2, 5]],
        ["pool-a", "fixed", [1, 3]],
        ["pool-b", "fixed", [0, 3]],
      ]);
    }

    const diff = diffPluginSdkApi(baseline, changed);
    expect(diff.exports.map(({ change, exportName }) => ({ change, exportName }))).toEqual([
      { change: "reachable", exportName: "preview" },
      { change: "reachable", exportName: "send" },
    ]);
    expect(diff.exports[0]?.declarationChanges).toEqual([
      expect.objectContaining({
        after: expect.stringContaining("accountId: string"),
        before: expect.stringContaining("text: string"),
        name: expect.stringContaining("SharedOptions"),
      }),
    ]);
    expect(diff.exports[1]?.declarationChanges).toEqual([]);
    expect(JSON.stringify(diff).match(/type SharedOptions/gu)).toHaveLength(2);
    const report = formatPluginSdkApiDiffReport({ baseLabel: "base", diff, headLabel: "head" });
    expect(report).toContain("Affected exports (2)");
    expect(report).toContain("`openclaw/plugin-sdk/fixture` — `preview` (reachable)");
    expect(report).toContain("`openclaw/plugin-sdk/fixture` — `send` (reachable)");
    expect(report).not.toContain("affects 1 export");
  });

  it("validates renderer artifacts at the subprocess boundary", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": "export type Fixture = { value: string };\n",
    });
    const parsed = parsePluginSdkApiDiffSurface(JSON.stringify(baseline));

    expect(hasPluginSdkApiChanges(diffPluginSdkApi(baseline, parsed))).toBe(false);
    expect(() =>
      parsePluginSdkApiDiffSurface('{"declarationSections":[],"modules":[{"entrypoint":1}]}'),
    ).toThrow("invalid module");
  });

  it("reports public types resolved from each revision's dependency declarations", async () => {
    const before = await renderDependencyDeclarationFixture(
      "export declare const fixtureValue: { oldValue: string };\n",
    );
    const after = await renderDependencyDeclarationFixture(
      "export declare const fixtureValue: { newValue: number };\n",
    );
    const diff = diffPluginSdkApi(before, after);
    const report = formatPluginSdkApiDiffReport({ baseLabel: "base", diff, headLabel: "head" });

    expect(diff.exports).toEqual([
      expect.objectContaining({ change: "signature", exportName: "publicValue" }),
    ]);
    expect(report).toContain("oldValue: string");
    expect(report).toContain("newValue: number");
    expect(report).toContain(`Acknowledgement digest: \`${pluginSdkApiAcknowledgement(diff)}\``);
  });

  it("bounds reports by UTF-8 bytes without splitting multibyte text", () => {
    const diff: PluginSdkApiDiff = {
      digest: "a".repeat(64),
      entrypointsAdded: [],
      entrypointsRemoved: [],
      exports: [
        {
          after: {
            closureHash: "b".repeat(64),
            declaration: `type Wide = "${"界".repeat(70_000)}";`,
            kind: "type",
          },
          before: null,
          change: "added",
          declarationChanges: [],
          entrypoint: "fixture",
          exportName: "Wide",
          importSpecifier: "openclaw/plugin-sdk/fixture",
        },
      ],
    };

    const report = formatPluginSdkApiDiffReport({ baseLabel: "base", diff, headLabel: "head" });
    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(report).toContain("summary truncated");
    expect(report).not.toContain("�");
  });

  it("renders byte-identical surfaces deterministically", async () => {
    const firstRender = await renderPrivateDeclarationFixture();
    const secondRender = await renderPrivateDeclarationFixture({ comments: true });
    const fixtureError = firstRender.modules[0]?.exports.find(
      (exportSurface) => exportSurface.exportName === "FixtureError",
    )?.declaration;

    expect(secondRender).toEqual(firstRender);
    expect(fixtureError).toContain("constructor(status: number);");
    expect(fixtureError).toContain("getStatus(): number;");
    expect(fixtureError).not.toContain("super(");
    expect(fixtureError).not.toContain("return this.status");
  });

  it.each(["source project creation", "declaration emission"])(
    "rejects source changes after %s while accepting linked external types",
    async (timing) => {
      const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-mutation-");
      const external = tempDirs.make("openclaw-plugin-sdk-api-linked-");
      const entry = path.join(repoRoot, "src/plugin-sdk/fixture.ts");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, "node_modules"));
      fs.writeFileSync(path.join(repoRoot, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(repoRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ESNext",
            types: [],
          },
        }),
      );
      fs.writeFileSync(
        path.join(external, "package.json"),
        '{"name":"fixture-linked","type":"module","types":"index.d.ts"}',
      );
      fs.writeFileSync(
        path.join(external, "index.d.ts"),
        'export declare const externalValue: "external";\n',
      );
      fs.symlinkSync(external, path.join(repoRoot, "node_modules/fixture-linked"), "junction");
      const source = (origin: string) =>
        [
          'import { externalValue } from "fixture-linked";',
          "export const linked = externalValue;",
          `export const local = "${origin}" as const;`,
        ].join("\n");
      fs.writeFileSync(entry, source("checked"));
      const render = () => renderPluginSdkApiBaseline({ repoRoot, entrypoints: ["fixture"] });
      const stable = await render();
      expect(stable.modules[0]?.exports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            exportName: "linked",
            declaration: expect.stringContaining('"external"'),
          }),
          expect.objectContaining({
            exportName: "local",
            declaration: expect.stringContaining('"checked"'),
          }),
        ]),
      );

      let changed = false;
      const changeSource = () => {
        changed = true;
        fs.writeFileSync(entry, source("changed"));
      };
      const sourceConfig = path
        .join(repoRoot, ".openclaw-plugin-sdk-api.tsconfig.json")
        .split(path.sep)
        .join("/");
      const createProject = nativeTypeScript.createNativeTypeScriptProject;
      const create = vi.spyOn(nativeTypeScript, "createNativeTypeScriptProject");
      const emit = vi.spyOn(Program.prototype, "emitToString");
      if (timing === "source project creation") {
        create.mockImplementationOnce(function intercept(options) {
          const native = createProject(options);
          if (options.configFileName.split(path.sep).join("/") === sourceConfig) {
            expect(native.project.program.getSourceFile(entry)?.getText()).toContain('"checked"');
            changeSource();
          } else {
            create.mockImplementationOnce(intercept);
          }
          return native;
        });
      } else {
        emit.mockImplementationOnce(async function (this: Program, ...args) {
          emit.mockRestore();
          const result = await this.emitToString(...args);
          expect(
            (await this.getSourceFileNames()).some((file) => path.resolve(file) === entry),
          ).toBe(true);
          expect(result.emitSkipped).toBe(false);
          expect(result.diagnostics).toEqual([]);
          changeSource();
          return result;
        });
      }
      try {
        await expect(render()).rejects.toThrow(/Boundary .*changed during compilation/u);
      } finally {
        create.mockRestore();
        emit.mockRestore();
      }
      expect(changed).toBe(true);
      expect(fs.readFileSync(entry, "utf8")).toBe(source("changed"));
      expect(fs.readdirSync(path.join(repoRoot, ".artifacts"))).toEqual([]);
    },
  );

  it("fails when a declaration dependency cannot be resolved", async () => {
    await expect(
      renderSourceFixture({
        "fixture.ts": [
          'import type { Missing } from "missing-plugin-sdk-dependency";',
          "export declare function createFixture(value: Missing): void;",
        ].join("\n"),
      }),
    ).rejects.toThrow("missing-plugin-sdk-dependency");
  });

  it("resolves declaration import types under their explicit package conditions", async () => {
    const render = (esmField: string) =>
      renderSourceFixture({
        "../../package.json": JSON.stringify({
          type: "module",
          imports: {
            "#shape": { import: "./src/plugin-sdk/esm.ts", require: "./src/plugin-sdk/cjs.ts" },
          },
        }),
        "fixture.ts": [
          'export declare function importShape(value: import("#shape", { with: { "resolution-mode": "import" } }).Shape): void;',
          'export declare function requireShape(value: import("#shape", { with: { "resolution-mode": "require" } }).Shape): void;',
        ].join("\n"),
        "esm.ts": `export type Shape = { ${esmField}: string };`,
        "cjs.ts": "export type Shape = { commonjs: number };",
      });
    const before = await render("original");
    const after = await render("changed");

    expect(diffPluginSdkApi(before, after).exports.map(({ exportName }) => exportName)).toEqual([
      "importShape",
    ]);
    expect(before.declarationSections.map(({ text }) => text).join("\n")).toContain(
      "commonjs: number",
    );
  });

  it("keeps hashes stable when reachable declarations move", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": [
        'import type { Leaf } from "./dep/leaf.js";',
        "export declare function createFixture(value: Leaf): Leaf;",
      ].join("\n"),
      "dep/leaf.ts": "export type Leaf = { value: string };\n",
    });
    const moved = await renderSourceFixture({
      "fixture.ts": [
        'import type { Leaf } from "./moved/leaf.js";',
        "export declare function createFixture(value: Leaf): Leaf;",
      ].join("\n"),
      "moved/leaf.ts": "export type Leaf = { value: string };\n",
    });

    expect(moved).toEqual(baseline);
  });

  it("includes globals from side-effect imports in closure hashes", async () => {
    const render = (optionalValue: boolean) =>
      renderSourceFixture({
        "fixture.ts": [
          'import "./ambient.js";',
          "export declare function createFixture(value: OpenClawBaselineFixtureGlobal): void;",
        ].join("\n"),
        "ambient.ts": [
          "declare global {",
          `  interface OpenClawBaselineFixtureGlobal { value${optionalValue ? "?" : ""}: string }`,
          "}",
          "export {};",
        ].join("\n"),
      });
    const baseline = await render(false);
    const changed = await render(true);

    expect(baseline.declarationSections.find(({ name }) => name === "global")?.text).toMatch(
      /^declare global \{/u,
    );
    expect(changed.modules[0]?.exports[0]?.closureHash).not.toBe(
      baseline.modules[0]?.exports[0]?.closureHash,
    );
  });

  it("keeps hashes stable when unqualified repo import types move", async () => {
    const baseline = await renderSourceFixture({
      "fixture.ts": 'export declare const fixture: typeof import("./dep/mod.js");\n',
      "dep/mod.ts": "export const value = 1;\n",
    });
    const moved = await renderSourceFixture({
      "fixture.ts": 'export declare const fixture: typeof import("./moved/mod.js");\n',
      "moved/mod.ts": "export const value = 1;\n",
    });

    expect(moved).toEqual(baseline);
  });

  it("ignores unreachable transitive declaration changes", async () => {
    const render = (extra = "") =>
      renderSourceFixture({
        "fixture.ts": [
          'import type { Bridge } from "./bridge.js";',
          "export declare function createFixture(value: Bridge): Bridge;",
        ].join("\n"),
        "bridge.ts": [
          'import type { Shared } from "./shared.js";',
          "export type Bridge = { shared: Shared };",
        ].join("\n"),
        "shared.ts": `export type Shared = { value: string };\n${extra}`,
      });
    const baseline = await render();
    const unrelated = await render("export type TelegramProbe = { ignored: boolean };\n");

    expect(unrelated).toEqual(baseline);
  });

  it("bounds repeated work inside a cyclic declaration fanout without sharing partial roots", () => {
    const repoRoot = tempDirs.make("openclaw-plugin-sdk-cyclic-fanout-");
    const files = Array.from({ length: 7 }, (_, index) =>
      path.join(repoRoot, `cycle${index}.d.ts`),
    );
    for (const [index, file] of files.entries()) {
      const siblings = files.map((_, other) => other).filter((other) => other !== index);
      fs.writeFileSync(
        file,
        [
          ...siblings.map((other) => `import type { C${other} } from "./cycle${other}.js";`),
          `export interface C${index} { marker${index}: string; ${siblings.map((other) => `c${other}?: C${other};`).join(" ")} }`,
        ].join("\n"),
      );
    }
    const configFileName = path.join(repoRoot, "tsconfig.json");
    using native = nativeTypeScript.createNativeTypeScriptProject({
      cwd: repoRoot,
      configFileName,
      files: {
        [configFileName]: JSON.stringify({
          compilerOptions: { target: "esnext", module: "nodenext", moduleResolution: "nodenext" },
          files,
        }),
      },
    });
    const { program } = native.project;
    const printer = native.project.emitter;
    // Materialize the native API's instance-cached method before Vitest wraps it.
    void printer.printNode;
    const print = vi.spyOn(printer, "printNode");
    const render = createDeclarationClosureRenderer({
      project: native.project,
      sourceProgram: program,
      emittedSources: new Set(),
      repoRoot,
    });
    const first = render(program.getSourceFile(files[0]!)!, "C0");
    const second = render(program.getSourceFile(files[3]!)!, "C3");
    expect(first?.sections.map((section) => section.name)).toEqual(
      files.map((_, index) => `C${index}`),
    );
    expect(second).toEqual(first);
    // A dense cycle previously printed 3,914 declarations for these two roots.
    expect(print.mock.calls.length).toBeLessThan(100);
  });

  it("keeps cycle members complete across cached export walks", async () => {
    const render = (optionalMarker: boolean) =>
      renderSourceFixture(
        {
          "cycle-a.ts": [
            'import type { A } from "./a.js";',
            "export declare function first(value: A): A;",
          ].join("\n"),
          "cycle-b.ts": [
            'import type { B } from "./b.js";',
            "export declare function second(value: B): B;",
          ].join("\n"),
          "a.ts": [
            'import type { B } from "./b.js";',
            `export type A = { marker${optionalMarker ? "?" : ""}: string; b?: B };`,
          ].join("\n"),
          "b.ts": [
            'import type { A } from "./a.js";',
            "export type B = { value: string; a?: A };",
          ].join("\n"),
        },
        ["cycle-a", "cycle-b"],
      );
    const baseline = await render(false);
    const changed = await render(true);
    const closureHash = (result: PluginSdkApiBaseline) =>
      result.modules.find((moduleSurface) => moduleSurface.entrypoint === "cycle-b")?.exports[0]
        ?.closureHash;

    expect(closureHash(changed)).not.toBe(closureHash(baseline));
  });

  it("ignores unrelated declarations beside an aliased re-export", async () => {
    const render = (extra = "") =>
      renderSourceFixture({
        "fixture.ts": 'export { internalFixture as publicFixture } from "./dep.js";\n',
        "dep.ts": `export function internalFixture(value: string): string { return value; }\n${extra}`,
      });
    const baseline = await render();
    const unrelated = await render("export type Unrelated = { ignored: boolean };\n");
    const declaration = baseline.modules[0]?.exports[0]?.declaration;

    expect(unrelated).toEqual(baseline);
    expect(declaration).toContain("function publicFixture(");
    expect(declaration).not.toContain("internalFixture");
  });

  it("captures transitive private declaration changes deterministically", async () => {
    const baseline = await renderPrivateDeclarationFixture();
    const optionChanged = await renderPrivateDeclarationFixture({ optionalOption: true });
    const resultChanged = await renderPrivateDeclarationFixture({ optionalResult: true });
    const declaration = baseline.modules[0]?.exports[0];

    expect(declaration).toEqual(
      expect.objectContaining({
        exportName: "createFixture",
        kind: "function",
        source: { path: "src/plugin-sdk/fixture.ts" },
      }),
    );
    expect(declaration?.closureHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(declaration?.closureSectionIds?.map((id) => baseline.declarationSections[id])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "FixtureOptionLeaf",
          text: expect.stringContaining("required: string"),
        }),
        expect.objectContaining({
          name: "FixtureResult",
          text: expect.stringContaining("FixtureResultLeaf"),
        }),
      ]),
    );
    expect(declaration?.declaration).toContain("FixtureOptions");
    expect(declaration?.declaration).toContain("FixtureResult");
    expect(declaration?.declaration).not.toContain("required: string;");
    expect(declaration?.declaration).not.toContain("value: string;");
    expect(declaration?.declaration).not.toContain("externalOnly: string;");

    for (const changed of [optionChanged, resultChanged]) {
      expect(changed.modules[0]?.exports[0]?.declaration).toBe(declaration?.declaration);
      expect(changed.modules[0]?.exports[0]?.closureHash).not.toBe(declaration?.closureHash);
    }
  });
});
