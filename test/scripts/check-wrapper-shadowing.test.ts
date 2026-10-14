import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRepositoryWrapperShadowing } from "../../scripts/check-wrapper-shadowing.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

const guardScriptPath = fileURLToPath(
  new URL("../../scripts/check-wrapper-shadowing.mts", import.meta.url),
);

type GuardFixture = Record<string, string>;

async function runFixture(files: GuardFixture) {
  return await withTempDir("openclaw-wrapper-shadowing-", async (repoRoot) => {
    await Promise.all(
      Object.entries(files).map(async ([repoPath, content]) => {
        const filePath = path.join(repoRoot, repoPath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
      }),
    );
    return await collectRepositoryWrapperShadowing(repoRoot);
  });
}

const directViolation: GuardFixture = {
  "src/inner.js": "export function runTask() { return 'inner'; }\n",
  "src/outer.ts": [
    'import { runTask as runTaskInner } from "./inner.js";',
    "export function runTask() {",
    "  prepareTask();",
    "  return runTaskInner();",
    "}",
  ].join("\n"),
};

const wrapperThroughFacade: GuardFixture = {
  "src/inner.ts": "export function runTask() { return 'inner'; }\n",
  "src/outer.ts": [
    'import { runTask as runTaskFacade } from "./facade.js";',
    "export function runTask() {",
    "  prepareTask();",
    "  return runTaskFacade();",
    "}",
  ].join("\n"),
};

describe("wrapper shadowing guard", () => {
  it("fails for a same-name wrapper around an imported implementation", async () => {
    const result = await runFixture({
      ...directViolation,
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `src/module-${String(index).padStart(2, "0")}.ts`,
          `export const value${index} = ${index};`,
        ]),
      ),
    });

    expect(result).toEqual([{ name: "runTask", wrapped: "src/inner.js", wrapper: "src/outer.ts" }]);
  });

  it.each([
    ["pure re-export", 'export { runTask } from "./inner.js";'],
    [
      "untyped identity alias",
      'import { runTask as runTaskInner } from "./inner.js"; export const runTask = runTaskInner;',
    ],
    [
      "typed identity alias",
      'import { runTask as runTaskInner } from "./inner.js"; export const runTask: () => string = runTaskInner;',
    ],
    [
      "namespace identity alias",
      'import * as runtime from "./inner.js"; export const runTask = runtime.runTask;',
    ],
  ])("passes for a %s", async (_name, content) => {
    const result = await runFixture({
      "src/inner.ts": "export function runTask() { return 'inner'; }\n",
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
      "src/outer.ts": `import { runTask as runTaskInner } from "./inner.js";\n${declaration}`,
    });

    expect(result).toEqual([{ name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts" }]);
  });

  it.each<{ name: string; files: GuardFixture; wrapped: string | undefined }>([
    {
      name: "typed identity re-export",
      files: {
        "src/facade.ts":
          'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
      },
      wrapped: "src/inner.ts",
    },
    ...(
      [
        [
          "two identity aliases",
          'import * as bridge from "./bridge.js"; export const runTask = bridge.runTask;',
        ],
        ["named barrel and identity alias", 'export { runTask } from "./bridge.js";'],
        ["star barrel and identity alias", 'export * from "./bridge.js";'],
      ] as const
    ).map(([name, facade]) => ({
      name,
      files: {
        "src/bridge.ts":
          'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
        "src/facade.ts": facade,
      },
      wrapped: "src/inner.ts",
    })),
    {
      name: "cycle with an alternate definition",
      files: {
        "src/facade.ts": 'export * from "./cycle.js"; export * from "./inner.js";',
        "src/cycle.ts": 'export * from "./facade.js";',
      },
      wrapped: "src/inner.ts",
    },
    ...[false, true].map((distinct) => ({
      name: distinct ? "ambiguous star origins" : "duplicate paths to one origin",
      files: {
        "src/facade.ts": 'export * from "./left.js"; export * from "./right.js";',
        "src/left.ts": 'export { runTask } from "./inner.js";',
        "src/right.ts": `export { runTask } from "./${distinct ? "other" : "inner"}.js";`,
        "src/other.ts": "export function runTask() { return 'other'; }",
      },
      wrapped: distinct ? undefined : "src/inner.ts",
    })),
    ...(
      [
        ["local", "export function runTask() { return 'local'; }", "src/facade.ts"],
        ["named", 'export { runTask } from "./inner.js";', "src/inner.ts"],
        ["renamed", 'export { otherTask as runTask } from "./other.js";', undefined],
      ] as const
    ).map(([name, binding, wrapped]) => ({
      name: `${name} binding shadows stars`,
      files: {
        "src/facade.ts": `${binding}\nexport * from "./${name === "renamed" ? "inner" : "other"}.js";`,
        "src/other.ts":
          "export function runTask() { return 'other'; } export function otherTask() { return 'other'; }",
      },
      wrapped,
    })),
  ])("resolves the wrapper origin through $name", async ({ files, wrapped }) => {
    expect(await runFixture({ ...wrapperThroughFacade, ...files })).toEqual(
      wrapped
        ? [
            {
              name: "runTask",
              wrapped,
              wrapper: "src/outer.ts",
              ...(wrapped === "src/facade.ts" ? {} : { via: "src/facade.ts" }),
            },
          ]
        : [],
    );
  });

  it("keeps a chain of identity-only facades exempt", async () => {
    expect(
      await runFixture({
        "src/inner.ts": "export function runTask() { return 'inner'; }",
        "src/bridge.ts":
          'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
        "src/facade.ts":
          'import * as bridge from "./bridge.js"; export const runTask = bridge.runTask;',
      }),
    ).toEqual([]);
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
