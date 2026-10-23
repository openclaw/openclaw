import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRepositoryWrapperShadowing } from "../../scripts/check-wrapper-shadowing.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const guardScriptPath = fileURLToPath(
  new URL("../../scripts/check-wrapper-shadowing.mts", import.meta.url),
);

type GuardFixture = Record<string, string>;

async function runFixture(files: GuardFixture) {
  return await withTempDir("openclaw-wrapper-shadowing-", async (repoRoot) => {
    writeFixtureFiles(repoRoot, files);
    return await collectRepositoryWrapperShadowing(repoRoot);
  });
}

const inner = "export function runTask() { return 'inner'; }\n";
const imported = (declaration: string) =>
  `import { runTask as runTaskInner } from "./inner.js"; ${declaration}`;
const identity = imported("export const runTask: () => string = runTaskInner;");
const namespaceIdentity =
  'import * as bridge from "./bridge.js"; export const runTask = bridge.runTask;';
function wrapperFixture(module: string, extension = "ts"): GuardFixture {
  return {
    [`src/inner.${extension}`]: inner,
    "src/outer.ts": `import { runTask as implementation } from "./${module}.js";
export function runTask() {
  prepareTask();
  return implementation();
}`,
  };
}

function origin(name: string, files: GuardFixture, wrapped: string | null = "src/inner.ts") {
  return { name, files, wrapped };
}
function violation(wrapped: string, via?: string) {
  return { name: "runTask", wrapped, wrapper: "src/outer.ts", ...(via ? { via } : {}) };
}

describe("wrapper shadowing guard", () => {
  it("fails for a same-name wrapper around an imported implementation", async () => {
    const result = await runFixture({
      ...wrapperFixture("inner", "js"),
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `src/module-${String(index).padStart(2, "0")}.ts`,
          `export const value${index} = ${index};`,
        ]),
      ),
    });

    expect(result).toEqual([violation("src/inner.js")]);
  });

  it.each([
    ["pure re-export", 'export { runTask } from "./inner.js";'],
    ["untyped identity alias", imported("export const runTask = runTaskInner;")],
    ["typed identity alias", identity],
    [
      "namespace identity alias",
      'import * as runtime from "./inner.js"; export const runTask = runtime.runTask;',
    ],
  ])("passes for a %s", async (_name, content) => {
    const result = await runFixture({
      "src/inner.ts": inner,
      "src/outer.ts": content,
    });

    expect(result).toEqual([]);
  });

  it.each([
    ["typed arrow wrapper", "export const runTask: () => string = () => runTaskInner();"],
    ["call initializer", "export const runTask = runTaskInner();"],
    ["destructured binding", "export const { runTask } = runTaskInner;"],
  ])("still reports a %s as a value definition", async (_name, declaration) => {
    const result = await runFixture({
      "src/inner.ts":
        "export const runTask = Object.assign(() => 'inner', { runTask: () => 'nested' });",
      "src/outer.ts": imported(declaration),
    });

    expect(result).toEqual([violation("src/inner.ts")]);
  });

  it.each([
    origin("typed identity re-export", { "src/facade.ts": identity }),
    ...(
      [
        ["two identity aliases", namespaceIdentity],
        ["named barrel and identity alias", 'export { runTask } from "./bridge.js";'],
        ["star barrel and identity alias", 'export * from "./bridge.js";'],
      ] as const
    ).map(([name, facade]) => origin(name, { "src/bridge.ts": identity, "src/facade.ts": facade })),
    origin("cycle with an alternate definition", {
      "src/facade.ts": 'export * from "./cycle.js"; export * from "./inner.js";',
      "src/cycle.ts": 'export * from "./facade.js";',
    }),
    ...[false, true].map((distinct) =>
      origin(
        distinct ? "ambiguous star origins" : "duplicate paths to one origin",
        {
          "src/facade.ts": 'export * from "./left.js"; export * from "./right.js";',
          "src/left.ts": 'export { runTask } from "./inner.js";',
          "src/right.ts": `export { runTask } from "./${distinct ? "other" : "inner"}.js";`,
          "src/other.ts": "export function runTask() { return 'other'; }",
        },
        distinct ? null : "src/inner.ts",
      ),
    ),
    ...(
      [
        ["local", "export function runTask() { return 'local'; }", "src/facade.ts"],
        ["named", 'export { runTask } from "./inner.js";', "src/inner.ts"],
        ["renamed", 'export { otherTask as runTask } from "./other.js";', null],
      ] as const
    ).map(([name, binding, wrapped]) =>
      origin(
        `${name} binding shadows stars`,
        {
          "src/facade.ts": `${binding}\nexport * from "./${name === "renamed" ? "inner" : "other"}.js";`,
          "src/other.ts":
            "export function runTask() { return 'other'; } export function otherTask() { return 'other'; }",
        },
        wrapped,
      ),
    ),
  ])("resolves the wrapper origin through $name", async ({ files, wrapped }) => {
    expect(await runFixture({ ...wrapperFixture("facade"), ...files })).toEqual(
      wrapped
        ? [violation(wrapped, wrapped === "src/facade.ts" ? undefined : "src/facade.ts")]
        : [],
    );
  });

  it("rejects debt-baseline updates with the wrapper trailer", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", guardScriptPath, "--update-debt-baseline"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
      "[check-wrapper-shadowing] FAILED (exit 2)",
    );
  });
});
