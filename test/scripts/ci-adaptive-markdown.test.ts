import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAdaptiveMarkdownFilter } from "../../scripts/lib/ci-adaptive-markdown.mjs";
import { createTestInputFingerprint } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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
  const select = (changes = [changed]) =>
    createAdaptiveMarkdownFilter(
      changes,
      createTestInputFingerprint(cwd),
      qualification,
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
