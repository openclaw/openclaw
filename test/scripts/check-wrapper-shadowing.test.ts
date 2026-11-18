import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { collectRepositoryWrapperShadowing } from "../../scripts/check-wrapper-shadowing.mts";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

type Files = Record<string, string>;
const inner = "export function task() {}";
const alias = 'import { task as impl } from "./inner.js"; export const task: () => void = impl;';
const named = 'export { task } from "./inner.js";';
const stars = 'export * from "./left.js"; export * from "./right.js";';
const wrapper = (module: string) =>
  `import { task as impl } from "./${module}.js"; export function task() { prepare(); return impl(); }`;

async function check(files: Files) {
  return withTempDir("openclaw-wrapper-shadowing-", async (root) => {
    writeFixtureFiles(
      root,
      Object.fromEntries(Object.entries(files).map(([name, text]) => [`src/${name}`, text])),
    );
    return collectRepositoryWrapperShadowing(root);
  });
}
const violation = (wrapped: string, via?: string) => ({
  name: "task",
  wrapped: `src/${wrapped}`,
  wrapper: "src/outer.ts",
  ...(via ? { via: `src/${via}` } : {}),
});

it("finds a JS implementation across parser batches", async () => {
  const fillers = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`module-${i}.ts`, "export {};"]),
  );
  expect(await check({ "inner.js": inner, "outer.ts": wrapper("inner"), ...fillers })).toEqual([
    violation("inner.js"),
  ]);
});

it.each([
  "export const task: () => void = () => impl();",
  "export const task = impl();",
  "export const { task } = impl;",
])("reports a value definition: %s", async (declaration) => {
  expect(
    await check({
      "inner.ts": "export const task = Object.assign(() => 0, { task: () => 1 });",
      "outer.ts": `import { task as impl } from "./inner.js"; ${declaration}`,
    }),
  ).toEqual([violation("inner.ts")]);
});

function starGraph(distinct: boolean): Files {
  return {
    "facade.ts": stars,
    "left.ts": named,
    "right.ts": `export { task } from "./${distinct ? "other" : "inner"}.js";`,
    "other.ts": inner,
  };
}
function shadowGraph(binding: string, star = "other"): Files {
  return {
    "facade.ts": `${binding} export * from "./${star}.js";`,
    "other.ts": `${inner} export function other() {}`,
  };
}

it.each<[string, Files, string | null]>([
  [
    "identity aliases",
    {
      "bridge.ts": alias,
      "facade.ts": 'import * as b from "./bridge.js"; export const task = b.task;',
    },
    "inner.ts",
  ],
  [
    "star and identity alias",
    { "bridge.ts": alias, "facade.ts": 'export * from "./bridge.js";' },
    "inner.ts",
  ],
  [
    "cycle",
    {
      "facade.ts": 'export * from "./cycle.js"; export * from "./inner.js";',
      "cycle.ts": 'export * from "./facade.js";',
    },
    "inner.ts",
  ],
  ["duplicate origins", starGraph(false), "inner.ts"],
  ["ambiguous origins", starGraph(true), null],
  ["local shadows stars", shadowGraph(inner), "facade.ts"],
  ["named shadows stars", shadowGraph(named), "inner.ts"],
  [
    "renamed shadows stars",
    shadowGraph('export { other as task } from "./other.js";', "inner"),
    null,
  ],
])("resolves %s", async (_name, files, wrapped) => {
  expect(await check({ "inner.ts": inner, "outer.ts": wrapper("facade"), ...files })).toEqual(
    wrapped ? [violation(wrapped, wrapped === "facade.ts" ? undefined : "facade.ts")] : [],
  );
});

it("rejects debt-baseline updates with the wrapper trailer", () => {
  const script = fileURLToPath(
    new URL("../../scripts/check-wrapper-shadowing.mts", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--update-debt-baseline"],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(2);
  expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(
    "[check-wrapper-shadowing] FAILED (exit 2)",
  );
});
