import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import markdownQualification from "../../config/ci-adaptive-markdown.json" with { type: "json" };
import { createAdaptiveMarkdownFilter } from "../../scripts/lib/ci-adaptive-markdown.mjs";
import { resolveChangedNodeTestTargets } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createTestInputFingerprint } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../config/ci-adaptive-markdown.json", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof markdownQualification }>();
  return { default: structuredClone(actual.default) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const root = "packages/markdown-core/src/";
const changed = `${root}frontmatter.ts`;
const changedTest = `${root}frontmatter.test.ts`;
const unchanged = `${root}fences.test.ts`;
const source = `${root}fences.ts`;

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
    )([changedTest, unchanged]);
  return { cwd, select };
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

it("admits a real separate-process companion with qualified inputs, retaining shared workers", () => {
  const production = `${root}link-spans.ts`;
  const separate = "src/link-understanding/runner.transport.test.ts";
  const allocation = "config/test-lines-allocations/reference-citation-link-budget.txt";
  const options = { selectionMode: "aggressive" as const };
  const changes = [production, separate, allocation];
  const fingerprint = createTestInputFingerprint(process.cwd());
  const commonHash = markdownQualification.commonHash;
  const testHash = markdownQualification.tests["packages/markdown-core/src/fences.test.ts"];
  try {
    // Qualify this fixture explicitly; dependency updates must not expire the admission proof.
    const commonFingerprint = fingerprint(markdownQualification.common);
    const testFingerprint = fingerprint([unchanged]);
    if (commonFingerprint === null || testFingerprint === null) {
      throw new Error("The admission fixture needs complete common and test inputs");
    }
    markdownQualification.commonHash = commonFingerprint;
    markdownQualification.tests["packages/markdown-core/src/fences.test.ts"] = testFingerprint;
    const baseline = resolveChangedNodeTestTargets(changes, options);
    const selected = resolveChangedNodeTestTargets(changes, { ...options, adaptiveMarkdown: true });
    expect(baseline).toContain(unchanged);
    expect(selected).not.toContain(unchanged);
    expect(selected).toContain(separate);
    const shared = [production, "src/auto-reply/chunk.test.ts"];
    expect(resolveChangedNodeTestTargets(shared, { ...options, adaptiveMarkdown: true })).toContain(
      unchanged,
    );
  } finally {
    markdownQualification.commonHash = commonHash;
    markdownQualification.tests["packages/markdown-core/src/fences.test.ts"] = testHash;
  }
});
