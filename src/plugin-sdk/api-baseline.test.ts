import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { afterEach, expect, it, vi } from "vitest";
import * as nativeTypeScript from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeArtifacts as writeFiles } from "../plugins/public-surface.test-support.js";
import { createDeclarationClosureRenderer } from "./api-baseline-declaration-closure.js";
import { formatPluginSdkApiTypeAlias as formatTypeAlias } from "./api-baseline-declaration-print.js";
import {
  normalizePluginSdkApiDeclarationText as normalizeDeclaration,
  normalizePluginSdkApiSourcePath as normalizeSourcePath,
  renderPluginSdkApiBaseline as renderBaseline,
  type PluginSdkApiBaseline,
} from "./api-baseline.js";
import {
  diffPluginSdkApi as diffApi,
  formatPluginSdkApiDiffReport,
  hasPluginSdkApiChanges as hasChanges,
  parsePluginSdkApiDiffSurface as parseSurface,
  pluginSdkApiAcknowledgement as acknowledgement,
  readPluginSdkApiEntrypoints as readEntrypoints,
  type PluginSdkApiDiff,
} from "./api-diff.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtureSource = { path: "src/plugin-sdk/fixture.ts" };
const tsOptions = { module: "NodeNext", moduleResolution: "NodeNext", target: "ESNext" };

function expectItems(actual: unknown, ...expected: Record<string, unknown>[]) {
  expect(actual).toEqual(expected.map((item) => expect.objectContaining(item)));
}

const containingItems = (...items: Record<string, unknown>[]) =>
  expect.arrayContaining(items.map((item) => expect.objectContaining(item)));

async function renderSourceFixture(
  source: string | Readonly<Record<string, string>>,
  entrypoints: readonly string[] = ["fixture"],
  { symlinked = false } = {},
) {
  const files = typeof source === "string" ? { "fixture.ts": source } : source;
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-api-");
  const sourceDir = path.join(repoRoot, "src", "plugin-sdk");
  writeFiles(repoRoot, { "tsconfig.json": `${JSON.stringify({ compilerOptions: tsOptions })}\n` });
  writeFiles(sourceDir, files);
  if (!symlinked) {
    return renderBaseline({ repoRoot, entrypoints });
  }
  const alias = path.join(tempDirs.make("openclaw-plugin-sdk-api-alias-"), "checkout");
  fs.symlinkSync(repoRoot, alias, "junction");
  return renderBaseline({ repoRoot: alias, entrypoints });
}

function optionFunctions(type: string, fields: string, ...names: string[]) {
  return [
    `type ${type} = { ${fields} };`,
    ...names.map((name) => `export declare function ${name}(options: ${type}): void;`),
  ].join("\n");
}

function importedFunction(type: string, file: string, name: string) {
  return `import type { ${type} } from "./${file}.js";\nexport declare function ${name}(value: ${type}): ${type};`;
}

function importedType(type: string, file: string, definition: string) {
  return `import type { ${type} } from "./${file}.js";\n${definition}`;
}

function report(diff: PluginSdkApiDiff) {
  return formatPluginSdkApiDiffReport({ baseLabel: "base", diff, headLabel: "head" });
}

const ps = (...args: string[]) => spawnSync("ps", args, { encoding: "utf8" });

function nativeProject(
  cwd: string,
  roots: string[],
  compilerOptions: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const configFileName = path.join(cwd, "tsconfig.json");
  return nativeTypeScript.createNativeTypeScriptProject({
    cwd,
    configFileName,
    files: { ...files, [configFileName]: JSON.stringify({ compilerOptions, files: roots }) },
  });
}

function writePluginSdkInventory(repoRoot: string, entrypoints: readonly string[]): void {
  writeFiles(path.join(repoRoot, "scripts", "lib"), {
    "plugin-sdk-entrypoints.json": `${JSON.stringify(entrypoints)}\n`,
    "plugin-sdk-private-local-only-subpaths.json": '["private-fixture"]\n',
  });
}

async function renderPrivateDeclarationFixture(params?: {
  comments?: boolean;
  optionalOption?: boolean;
  optionalResult?: boolean;
}) {
  return renderSourceFixture({
    "fixture.ts": `import type { FixtureOptionLeaf } from "./fixture-option.js";
import type { FixtureResultLeaf } from "./fixture-result.js";
${params?.comments ? "/** Options docs */ " : ""}type FixtureOptions = { nested: FixtureOptionLeaf };
type FixtureResult = { nested: FixtureResultLeaf };
export declare function createFixture(options: FixtureOptions): FixtureResult;
${params?.comments ? "/** Error docs */ " : ""}export class FixtureError extends Error {
  readonly status: number;
  constructor(status: number) { super("fixture"); this.status = status; }
  getStatus() { return this.status; }
}`,
    "fixture-option.ts": `import type { FixtureResultLeaf } from "./fixture-result.js";
import type { FixtureExternal } from "fixture-external";
export type FixtureOptionLeaf = { required${params?.optionalOption ? "?" : ""}: string; result?: FixtureResultLeaf; external?: FixtureExternal };`,
    "fixture-result.ts": 'export type { FixtureResultLeaf } from "./fixture-result-shape.js";\n',
    "fixture-result-shape.ts": importedType(
      "FixtureOptionLeaf",
      "fixture-option",
      `export type FixtureResultLeaf = { value${params?.optionalResult ? "?" : ""}: string; option?: FixtureOptionLeaf };`,
    ),
    "../../node_modules/fixture-external/package.json":
      '{"name":"fixture-external","types":"index.d.ts"}\n',
    "../../node_modules/fixture-external/index.d.ts":
      "export type FixtureExternal = { externalOnly: string };\n",
  });
}

async function renderDependencyDeclarationFixture(dependencyDeclaration: string) {
  return renderSourceFixture({
    "fixture.ts":
      'import { fixtureValue } from "fixture-dependency";\nexport const publicValue = fixtureValue;\n',
    "../../node_modules/fixture-dependency/package.json":
      '{"name":"fixture-dependency","type":"module","types":"index.d.ts"}\n',
    "../../node_modules/fixture-dependency/index.d.ts": dependencyDeclaration,
  });
}

it("normalizes declaration import paths to repo-relative paths", () => {
  const repoRoot = process.cwd();
  const modelCatalogPath = path.join(repoRoot, "src", "agents", "agent-model-discovery");
  const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

  const normalized = normalizeDeclaration(repoRoot, declaration);

  expect(normalized).not.toContain(repoRoot);
  expect(normalized).toContain('import("<repo>", { with: { "resolution-mode": "import" } })');
  expect(
    normalizeDeclaration(
      repoRoot,
      'type Owned = import("src/x").Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("src/x"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
    ),
  ).toBe(
    'type Owned = Foo; type External = import("node_modules/pkg/x").Foo; type Namespace = typeof import("<repo>"); type ExternalNamespace = typeof import("node_modules/pkg/x");',
  );
});

it("normalizes source paths under pnpm node_modules", () => {
  const repo = path.join(path.sep, "workspace", "openclaw-worktree");
  const dependency =
    "node_modules/.pnpm/@openclaw+fs-safe@1.0.0/node_modules/@openclaw/fs-safe/dist/secret-file.d.ts";
  expect(normalizeSourcePath(repo, path.join(repo, dependency))).toBe(
    "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
  );
});

it.each([false, true])("keeps tuple unions stable with prior discovery: %s", (prewarm) => {
  const cwd = tempDirs.make("openclaw-plugin-sdk-tuple-");
  const fileName = path.join(cwd, "fixture.ts");
  using native = nativeProject(
    cwd,
    [fileName],
    { noLib: true, target: "esnext", types: [] },
    {
      [fileName]: `interface Array<T> { [index: number]: T; readonly length: number }
interface ReadonlyArray<T> { readonly [index: number]: T; readonly length: number }
type Warmup = 1;
const VALUES = [3, 1, 2] as const;
type Value = (typeof VALUES)[number];`,
    },
  );
  const { checker, program } = native.project;
  const [warmup, alias] =
    program.getSourceFile(fileName)?.statements.filter(ts.isTypeAliasDeclaration) ?? [];
  if (!warmup || !alias) {
    throw new Error("Missing tuple fixture type aliases");
  }
  if (prewarm) {
    checker.getTypeAtLocation(warmup);
  }
  expect(formatTypeAlias(checker, alias)).toBe("3 | 1 | 2");
});

it("preserves empty tuple defaults in public function signatures", async () => {
  const baseline = await renderSourceFixture({
    "fixture.ts": 'export { emptyDefault as publicEmptyDefault } from "./functions.js";\n',
    "functions.ts":
      "export declare function emptyDefault<const T extends readonly string[] = []>(value?: T): T;\n",
  });

  expectItems(baseline.modules[0]?.exports, {
    exportName: "publicEmptyDefault",
    declaration: expect.stringMatching(
      /export function publicEmptyDefault<const T extends readonly string\[\] = \[\s*\]>\(value\?: T\): T;/u,
    ),
  });
});

it("reads added and removed entrypoints from each revision's own inventory", async () => {
  const baseRoot = tempDirs.make("openclaw-plugin-sdk-api-base-");
  const headRoot = tempDirs.make("openclaw-plugin-sdk-api-head-");
  writePluginSdkInventory(baseRoot, ["fixture", "private-fixture"]);
  writePluginSdkInventory(headRoot, ["fixture", "added", "private-fixture"]);

  expect(await readEntrypoints(baseRoot)).toEqual(["fixture"]);
  expect(await readEntrypoints(headRoot)).toEqual(["fixture", "added"]);

  const before = await renderSourceFixture("export type Fixture = string;\n");
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
  const addedDiff = diffApi(before, after);
  const removedDiff = diffApi(after, before);
  expect(addedDiff.entrypointsAdded).toEqual([
    {
      entrypoint: "added",
      exportNames: ["createAdded"],
      importSpecifier: "openclaw/plugin-sdk/added",
    },
  ]);
  expectItems(addedDiff.exports, {
    change: "added",
    declarationChanges: containingItems({ after: expect.stringContaining("value: number") }),
    entrypoint: "added",
    exportName: "createAdded",
  });
  expect(removedDiff.exports[0]).toMatchObject({
    change: "removed",
    declarationChanges: containingItems({ before: expect.stringContaining("value: number") }),
  });
  expect(addedDiff.digest).not.toBe(diffApi(before, sameNamesDifferentContents).digest);
  expect(report(addedDiff)).toContain("value: number");
});

it("classifies exported signature changes separately from reachable-only changes", async () => {
  const render = (fields: string) =>
    renderSourceFixture(
      `export interface SendOptions { ${fields} }\nexport declare function send(options: SendOptions): void;`,
    );
  const baseline = await render("text: string");
  const changed = await render("text: string; accountId: string");

  const diff = diffApi(baseline, changed);
  expectItems(
    diff.exports,
    { change: "signature", exportName: "SendOptions" },
    { change: "reachable", exportName: "send" },
  );
  expect(diff.exports[0]?.declarationChanges.length).toBeGreaterThan(0);
  expect(diff.exports[1]?.declarationChanges).toEqual([]);
});

it("stores shared declaration detail once while retaining every affected export", async () => {
  const render = (field: string) =>
    renderSourceFixture(
      {
        "fixture.ts": optionFunctions("SharedOptions", `${field}: string`, "preview", "send"),
        "pool-a.ts": optionFunctions("PoolOptions", "value: string", "fixed"),
        "pool-b.ts": optionFunctions("PoolOptions", "value: number", "fixed"),
      },
      ["pool-b", "fixture", "pool-a"],
    );
  const baseline = await render("text");
  const changed = await render("accountId");

  expect(changed.declarationSections.map(({ name, text }) => [name, text])).toEqual([
    ["PoolOptions", expect.stringContaining("value: number;")],
    ["PoolOptions", expect.stringContaining("value: string;")],
    ["SharedOptions", expect.stringContaining("accountId: string;")],
    ["fixed", expect.stringContaining("function fixed(options: PoolOptions): void;")],
    ["preview", expect.stringContaining("function preview(options: SharedOptions): void;")],
    ["send", expect.stringContaining("function send(options: SharedOptions): void;")],
  ]);
  const references = changed.modules.flatMap(({ entrypoint, exports }) =>
    exports.map(({ exportName, closureSectionIds }) => [entrypoint, exportName, closureSectionIds]),
  );
  expect(references).toEqual([
    ["fixture", "preview", [2, 4]],
    ["fixture", "send", [2, 5]],
    ["pool-a", "fixed", [1, 3]],
    ["pool-b", "fixed", [0, 3]],
  ]);
  const diff = diffApi(baseline, changed);
  expect(diff.exports.map(({ change, exportName }) => ({ change, exportName }))).toEqual([
    { change: "reachable", exportName: "preview" },
    { change: "reachable", exportName: "send" },
  ]);
  expectItems(diff.exports[0]?.declarationChanges, {
    after: expect.stringContaining("accountId: string"),
    before: expect.stringContaining("text: string"),
    name: expect.stringContaining("SharedOptions"),
  });
  expect(diff.exports[1]?.declarationChanges).toEqual([]);
  expect(JSON.stringify(diff).match(/type SharedOptions/gu)).toHaveLength(2);
  const text = report(diff);
  expect(text).toContain("Affected exports (2)");
  expect(text).toContain("`openclaw/plugin-sdk/fixture` — `preview` (reachable)");
  expect(text).toContain("`openclaw/plugin-sdk/fixture` — `send` (reachable)");
  expect(text).not.toContain("affects 1 export");
});

it("validates renderer artifacts at the subprocess boundary", async () => {
  const baseline = await renderSourceFixture("export type Fixture = { value: string };\n");
  const parsed = parseSurface(JSON.stringify(baseline));

  expect(hasChanges(diffApi(baseline, parsed))).toBe(false);
  expect(() => parseSurface('{"declarationSections":[],"modules":[{"entrypoint":1}]}')).toThrow(
    "invalid module",
  );
});

it("reports public types resolved from each revision's dependency declarations", async () => {
  const before = await renderDependencyDeclarationFixture(
    "export declare const fixtureValue: { oldValue: string };\n",
  );
  const after = await renderDependencyDeclarationFixture(
    "export declare const fixtureValue: { newValue: number };\n",
  );
  const diff = diffApi(before, after);
  const text = report(diff);

  expectItems(diff.exports, { change: "signature", exportName: "publicValue" });
  expect(text).toContain("oldValue: string");
  expect(text).toContain("newValue: number");
  expect(text).toContain(`Acknowledgement digest: \`${acknowledgement(diff)}\``);
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

  const text = report(diff);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
  expect(text).toContain("summary truncated");
  expect(text).not.toContain("�");
});

it.skipIf(process.platform === "win32")(
  "joins the native declaration compiler before opening semantic overlays",
  async () => {
    const createProject = nativeTypeScript.createNativeTypeScriptProject;
    let observedOverlay = false;
    const create = vi
      .spyOn(nativeTypeScript, "createNativeTypeScriptProject")
      .mockImplementation((options) => {
        if (Object.keys(options.files ?? {}).some((file) => file.endsWith("fixture.ts"))) {
          observedOverlay = true;
          const processes = ps("-ww", "-axo", "args=");
          expect(processes.error).toBeUndefined();
          expect([processes.status, processes.stderr]).toEqual([0, ""]);
          expect(
            processes.stdout
              .split("\n")
              .filter((line) => line.includes("--api --async") && line.includes(options.cwd)),
          ).toEqual([]);
        }
        return createProject(options);
      });
    try {
      const rendered = await renderSourceFixture("export const value = 1;");
      expect(observedOverlay).toBe(true);
      expect(rendered.modules[0]?.exports[0]?.declaration).toBe("export const value: 1;");
    } finally {
      create.mockRestore();
    }
  },
);

it("renders a checkout reached through a symlinked alias", async () => {
  // macOS temporary revision checkouts sit behind the /var -> /private/var alias.
  const baseline = await renderSourceFixture(
    "export declare function measure(value: string): number;\n",
    ["fixture"],
    { symlinked: true },
  );

  expectItems(baseline.modules, {
    source: fixtureSource,
    exports: [
      expect.objectContaining({
        exportName: "measure",
        declaration: expect.stringContaining("export function measure(value: string): number;"),
      }),
    ],
  });
});

it("fails when a declaration dependency cannot be resolved", async () => {
  await expect(
    renderSourceFixture(
      'import type { Missing } from "missing-plugin-sdk-dependency";\nexport declare function createFixture(value: Missing): void;',
    ),
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

  expect(diffApi(before, after).exports.map(({ exportName }) => exportName)).toEqual([
    "importShape",
  ]);
  expect(before.declarationSections.map(({ text }) => text).join("\n")).toContain(
    "commonjs: number",
  );
});

it("keeps hashes stable when unqualified declarations move", async () => {
  const render = (directory: string) =>
    renderSourceFixture({
      "fixture.ts": `export declare const fixture: typeof import("./${directory}/mod.js");\n`,
      [`${directory}/mod.ts`]: "export const value = 1;\n",
    });
  expect(await render("moved")).toEqual(await render("dep"));
});

it("includes globals from side-effect imports in closure hashes", async () => {
  const render = (optionalValue: boolean) =>
    renderSourceFixture({
      "fixture.ts":
        'import "./ambient.js";\nexport declare function createFixture(value: OpenClawBaselineFixtureGlobal): void;',
      "ambient.ts": `declare global {
  interface OpenClawBaselineFixtureGlobal { value${optionalValue ? "?" : ""}: string }
}
export {};`,
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

it("ignores unreachable declarations beside a transitive export", async () => {
  const render = (extra = "") =>
    renderSourceFixture({
      "fixture.ts": importedFunction("Bridge", "bridge", "createFixture"),
      "bridge.ts": importedType("Shared", "shared", "export type Bridge = { shared: Shared };"),
      "shared.ts": `export type Shared = { value: string };\n${extra}`,
    });
  const baseline = await render();
  expect(await render("export type Unrelated = { ignored: boolean };\n")).toEqual(baseline);
});

it("bounds repeated work inside a cyclic declaration fanout without sharing partial roots", () => {
  const repoRoot = tempDirs.make("openclaw-plugin-sdk-cyclic-fanout-");
  const files = Array.from({ length: 7 }, (_, index) => path.join(repoRoot, `cycle${index}.d.ts`));
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
  using native = nativeProject(repoRoot, files, tsOptions);
  const { program } = native.project;
  const printer = native.api.printer;
  // Materialize the native API's instance-cached method before Vitest wraps it.
  void printer.printNode;
  const print = vi.spyOn(printer, "printNode");
  const render = createDeclarationClosureRenderer({
    project: native.project,
    printer,
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
        "cycle-a.ts": importedFunction("A", "a", "first"),
        "cycle-b.ts": importedFunction("B", "b", "second"),
        "a.ts": importedType(
          "B",
          "b",
          `export type A = { marker${optionalMarker ? "?" : ""}: string; b?: B };`,
        ),
        "b.ts": importedType("A", "a", "export type B = { value: string; a?: A };"),
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

it("captures private shape changes while ignoring documentation and implementations", async () => {
  const baseline = await renderPrivateDeclarationFixture();
  expect(await renderPrivateDeclarationFixture({ comments: true })).toEqual(baseline);
  const fixtureError = baseline.modules[0]?.exports.find(
    (exportSurface) => exportSurface.exportName === "FixtureError",
  )?.declaration;
  expect(fixtureError).toContain("constructor(status: number);");
  expect(fixtureError).toContain("getStatus(): number;");
  expect(fixtureError).not.toContain("super(");
  expect(fixtureError).not.toContain("return this.status");
  const optionChanged = await renderPrivateDeclarationFixture({ optionalOption: true });
  const resultChanged = await renderPrivateDeclarationFixture({ optionalResult: true });
  const declaration = baseline.modules[0]?.exports[0];

  expect(declaration).toMatchObject({
    exportName: "createFixture",
    kind: "function",
    source: fixtureSource,
    declaration: "export function createFixture(options: FixtureOptions): FixtureResult;",
  });
  expect(declaration?.closureHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(declaration?.closureSectionIds?.map((id) => baseline.declarationSections[id])).toEqual(
    containingItems(
      { name: "FixtureOptionLeaf", text: expect.stringContaining("required: string") },
      { name: "FixtureResult", text: expect.stringContaining("FixtureResultLeaf") },
    ),
  );

  for (const changed of [optionChanged, resultChanged]) {
    expect(changed.modules[0]?.exports[0]?.declaration).toBe(declaration?.declaration);
    expect(changed.modules[0]?.exports[0]?.closureHash).not.toBe(declaration?.closureHash);
  }

  const combined = await renderPrivateDeclarationFixture({
    optionalOption: true,
    optionalResult: true,
  });
  const combinedDiff = diffApi(baseline, combined);
  expectItems(combinedDiff.exports, {
    change: "reachable",
    entrypoint: "fixture",
    exportName: "createFixture",
  });
  expect(
    combinedDiff.exports.flatMap((change) =>
      change.declarationChanges.map((section) => section.name),
    ),
  ).toEqual(expect.arrayContaining(["FixtureOptionLeaf", "FixtureResultLeaf"]));
  expect(hasChanges(combinedDiff)).toBe(true);
  expect(acknowledgement(combinedDiff)).toMatch(/^[a-f0-9]{8}$/u);
  expect(report(combinedDiff)).toContain("Reachable declarations changed");
});
