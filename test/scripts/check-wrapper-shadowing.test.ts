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
    const result = await runFixture(directViolation);

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

  it("resolves a real wrapper through a typed identity re-export", async () => {
    const result = await runFixture({
      "src/inner.ts": "export function runTask() { return 'inner'; }\n",
      "src/facade.ts": [
        'import { runTask as runTaskInner } from "./inner.js";',
        "export const runTask: () => string = runTaskInner;",
      ].join("\n"),
      "src/outer.ts": [
        'import { runTask as runTaskFacade } from "./facade.js";',
        "export function runTask() {",
        "  prepareTask();",
        "  return runTaskFacade();",
        "}",
      ].join("\n"),
    });

    expect(result).toEqual([
      { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts", via: "src/facade.ts" },
    ]);
  });

  it.each([
    [
      "two identity aliases",
      'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
      'import * as bridge from "./bridge.js"; export const runTask = bridge.runTask;',
    ],
    [
      "a named barrel and an identity alias",
      'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
      'export { runTask } from "./bridge.js";',
    ],
    [
      "a star barrel and an identity alias",
      'import { runTask as inner } from "./inner.js"; export const runTask: () => string = inner;',
      'export * from "./bridge.js";',
    ],
  ])("resolves a real wrapper through %s", async (_name, bridge, facade) => {
    expect(
      await runFixture({
        ...wrapperThroughFacade,
        "src/bridge.ts": bridge,
        "src/facade.ts": facade,
      }),
    ).toEqual([
      { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts", via: "src/facade.ts" },
    ]);
  });

  it("resolves a cycle through its alternate definition branch", async () => {
    expect(
      await runFixture({
        ...wrapperThroughFacade,
        "src/facade.ts": 'export * from "./cycle.js"; export * from "./inner.js";',
        "src/cycle.ts": 'export * from "./facade.js";',
      }),
    ).toEqual([
      { name: "runTask", wrapped: "src/inner.ts", wrapper: "src/outer.ts", via: "src/facade.ts" },
    ]);
  });

  it.each([false, true])(
    "distinguishes duplicate paths from ambiguous star origins (distinct=%s)",
    async (distinct) => {
      const result = await runFixture({
        ...wrapperThroughFacade,
        "src/facade.ts": 'export * from "./left.js"; export * from "./right.js";',
        "src/left.ts": 'export { runTask } from "./inner.js";',
        "src/right.ts": `export { runTask } from "./${distinct ? "other" : "inner"}.js";`,
        "src/other.ts": "export function runTask() { return 'other'; }",
      });

      expect(result).toEqual(
        distinct
          ? []
          : [
              {
                name: "runTask",
                wrapped: "src/inner.ts",
                wrapper: "src/outer.ts",
                via: "src/facade.ts",
              },
            ],
      );
    },
  );

  it.each([
    ["local", "export function runTask() { return 'local'; }", "src/facade.ts"],
    ["named", 'export { runTask } from "./inner.js";', "src/inner.ts"],
  ])("keeps %s binding precedence over star exports", async (_name, binding, wrapped) => {
    expect(
      await runFixture({
        ...wrapperThroughFacade,
        "src/facade.ts": `${binding}\nexport * from "./other.js";`,
        "src/other.ts": "export function runTask() { return 'other'; }",
      }),
    ).toEqual([
      {
        name: "runTask",
        wrapped,
        wrapper: "src/outer.ts",
        ...(wrapped === "src/facade.ts" ? {} : { via: "src/facade.ts" }),
      },
    ]);
  });

  it("does not follow a star hidden by an explicitly renamed binding", async () => {
    expect(
      await runFixture({
        ...wrapperThroughFacade,
        "src/facade.ts":
          'export { otherTask as runTask } from "./other.js"; export * from "./inner.js";',
        "src/other.ts": "export function otherTask() { return 'other'; }",
      }),
    ).toEqual([]);
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
