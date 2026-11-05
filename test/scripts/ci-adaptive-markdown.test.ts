import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAdaptiveMarkdownFilter } from "../../scripts/lib/ci-adaptive-markdown.mjs";
import * as sourceFacts from "../../scripts/lib/test-selector-source-facts.mts";
import {
  createTestInputFingerprint,
  resolveAffectedTestsFromImportGraph,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const root = "packages/markdown-core/src/";
const changed = `${root}frontmatter.ts`;
const changedTest = `${root}frontmatter.test.ts`;
const unchanged = `${root}fences.test.ts`;
const source = `${root}fences.ts`;

it("keeps Markdown worker inputs independent of another lane's test inventory", () => {
  const cwd = tempDirs.make("markdown-worker-inputs-");
  const inputs = [
    "test/vitest/vitest.node-policy.global-setup.ts",
    "scripts/lib/vitest-node-args.mts",
    "scripts/lib/vitest-process-env.mts",
    "scripts/lib/arg-utils.mts",
    "scripts/lib/vitest-cli-mode.mts",
    "scripts/lib/vitest-local-scheduling.mts",
    "test/vitest/vitest.agents-paths.mjs",
    "test/vitest/vitest.cli-process-paths.mjs",
    "test/vitest/vitest.database-worker-core-paths.mjs",
  ];
  for (const file of inputs) {
    const original = new URL(`../../${file}`, import.meta.url);
    // The old flag owner is copied too, so this exercises the pre-fix import chain.
    if (fs.existsSync(original)) {
      const destination = path.join(cwd, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(original, destination);
    }
  }
  const roots = ["test/vitest/vitest.node-policy.global-setup.ts"];
  const before = createTestInputFingerprint(cwd)(roots);
  expect(before).not.toBeNull();
  fs.appendFileSync(
    path.join(cwd, "test/vitest/vitest.database-worker-core-paths.mjs"),
    "\nexport const unrelatedInventoryChange = true;\n",
  );
  expect(createTestInputFingerprint(cwd)(roots)).toBe(before);
});

function fixture() {
  const cwd = tempDirs.make("adaptive-markdown-");
  const contents: Record<string, string> = {
    "package.json": '{"type":"module"}',
    [changed]: "export const changed = true;",
    [changedTest]: 'import {changed} from "./frontmatter.js"; export {changed};',
    [source]: "export const fence = 1;",
    [unchanged]: 'import {fence} from "./fences.js"; export {fence};',
  };
  for (const [file, bytes] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), bytes);
  }
  const hash = (files: string[]) =>
    createHash("sha256")
      .update(
        JSON.stringify(
          files
            .toSorted()
            .map((file) => [file, createHash("sha256").update(contents[file]!).digest("hex")]),
        ),
      )
      .digest("hex");
  const qualification = {
    common: ["package.json"],
    commonHash: hash(["package.json"]),
    tests: { [unchanged]: hash([unchanged, source]) },
  };
  const select = (changes = [changed], isIndependentCompanion = (_file: string) => false) =>
    createAdaptiveMarkdownFilter(
      changes,
      createTestInputFingerprint(cwd),
      qualification,
      isIndependentCompanion,
      cwd,
    )([changedTest, unchanged]);
  return { cwd, select, qualification };
}

it("omits only qualified unchanged inputs, retaining changed and unqualified tests", () => {
  const { cwd, select } = fixture();
  expect(select()).toEqual([changedTest]);
  fs.writeFileSync(path.join(cwd, source), "export const fence = 2;");
  expect(select()).toEqual([changedTest, unchanged]);
});

it.each(["package.json", source, unchanged])(
  "retains the baseline when a qualified input disappears: %s",
  (file) => {
    const { cwd, select } = fixture();
    fs.unlinkSync(path.join(cwd, file));
    expect(select()).toEqual([changedTest, unchanged]);
  },
);

it("invalidates qualification when the test adds a dependency or global inputs change", () => {
  const { cwd, select } = fixture();
  fs.appendFileSync(path.join(cwd, unchanged), '\nimport "./frontmatter.js";');
  expect(select()).toEqual([changedTest, unchanged]);
  expect(select([changed, "test/setup.env.ts"])).toEqual([changedTest, unchanged]);
  expect(select([])).toEqual([changedTest, unchanged]);
  expect(select(["config/test-lines-allocations/markdown.txt"])).toEqual([changedTest, unchanged]);
});

it("invalidates common configuration changes and rejects symlink input substitution", () => {
  const { cwd, select } = fixture();
  fs.writeFileSync(path.join(cwd, "package.json"), '{"type":"commonjs"}');
  expect(select()).toEqual([changedTest, unchanged]);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"type":"module"}');
  fs.renameSync(path.join(cwd, source), path.join(cwd, "saved.ts"));
  fs.symlinkSync(path.join(cwd, "saved.ts"), path.join(cwd, source));
  expect(select()).toEqual([changedTest, unchanged]);
});

it("admits qualified companions and allocations only alongside a Markdown source", () => {
  const { select } = fixture();
  const companion = "src/transport.test.ts";
  const allocation = "config/test-lines-allocations/transport.txt";
  const independent = (file: string) => file === companion;
  expect(select([changed, companion, allocation], independent)).toEqual([changedTest]);
  expect(select([changed, companion])).toEqual([changedTest, unchanged]);
  expect(select([changed, changedTest])).toEqual([changedTest, unchanged]);
  expect(select([changed, `${root}companion.spec.ts`])).toEqual([changedTest, unchanged]);
  expect(select([companion, allocation], independent)).toEqual([changedTest, unchanged]);
});

it("admits regular production companions but keeps helpers, fixtures and missing inputs conservative", () => {
  const { cwd, select } = fixture();
  const companions = [
    "src/runtime.ts",
    "extensions/example/src/runtime.ts",
    "packages/example/runtime.mjs",
  ];
  const excluded = [
    "src/test-utils/runtime.ts",
    "src/runtime.test-support.ts",
    "src/fixtures/runtime.ts",
    "packages/example/vitest.config.ts",
    "packages/example/scripts/generate.ts",
    "scripts/runtime.ts",
  ];
  for (const file of [...companions, ...excluded]) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), "export const value = 1;");
    expect(select([changed, file])).toEqual(
      companions.includes(file) ? [changedTest] : [changedTest, unchanged],
    );
  }
  expect(select([changed, "src/missing.ts"])).toEqual([changedTest, unchanged]);
  fs.symlinkSync(path.join(cwd, companions[0]!), path.join(cwd, "src/linked.ts"));
  expect(select([changed, "src/linked.ts"])).toEqual([changedTest, unchanged]);
});

it("retains a qualified test when a production companion changes its input closure", () => {
  const { cwd, select, qualification } = fixture();
  const companion = "src/runtime.ts";
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, companion), "export const value = 1;");
  fs.appendFileSync(path.join(cwd, unchanged), '\nimport "../../../src/runtime.js";');
  qualification.tests[unchanged] = createTestInputFingerprint(cwd)([unchanged]) ?? "";
  expect(select([changed, companion])).toEqual([changedTest]);
  fs.writeFileSync(path.join(cwd, companion), "export const value = 2;");
  expect(select([changed, companion])).toEqual([changedTest, unchanged]);
});

it("shares the qualification graph with selection when changes include a non-source input", () => {
  const { cwd } = fixture();
  const changes = [changed, "config/test-lines-allocations/transport.txt"];
  const scans = vi.spyOn(sourceFacts, "readTestSelectorSourceFacts");
  try {
    expect(createTestInputFingerprint(cwd, changes)([unchanged])).not.toBeNull();
    expect(
      resolveAffectedTestsFromImportGraph(changes, cwd, {
        tooling: true,
        resolveAliases: true,
        runtimeOnly: true,
      }),
    ).toEqual([changedTest]);
    expect(scans).toHaveBeenCalledTimes(1);
  } finally {
    scans.mockRestore();
  }
});
