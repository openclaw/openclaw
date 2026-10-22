import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-mdx.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const checkerPath = path.resolve(import.meta.dirname, "../../scripts/check-docs-mdx.mjs");
const frontmatter = "---\ntitle: Example\n---\n";
const component = "<Note>\n  </Note>\n";
const mdxError = { type: "mdx", line: 5, column: 1 };

it.each([
  ["plain component", component, null],
  ["LF frontmatter", frontmatter + component, null],
  ["CRLF frontmatter", (frontmatter + component).replaceAll("\n", "\r\n"), null],
  ["YAML document-end delimiter", "---\ntitle: Example\n...\n" + component, null],
  ["LF MDX expression", frontmatter + "{\n", mdxError],
  ["CRLF MDX expression", (frontmatter + "{\n").replaceAll("\n", "\r\n"), mdxError],
  ["valid LF document", frontmatter + "# Valid\n", null],
  ["valid CRLF document", (frontmatter + "# Valid\n").replaceAll("\n", "\r\n"), null],
])("reports original source locations for %s", (_name, source, error) => {
  const root = createTempDir("openclaw-mdx-source-lines-");
  const sourcePath = path.join(root, "page.mdx");
  const reportPath = path.join(root, "report.json");
  writeFileSync(sourcePath, source);

  const result = spawnSync(process.execPath, [checkerPath, sourcePath, "--json-out", reportPath], {
    cwd: root,
    encoding: "utf8",
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(error ? 1 : 0);
  expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
    files: 1,
    errors: error ? [{ file: "page.mdx", ...error }] : [],
  });
  if (error) {
    expect(result.stderr).toContain(`page.mdx:${error.line}:${error.column}:`);
  }
});

it("accepts custom-site Persian and Thai navigation without a host whitelist", () => {
  const root = createTempDir("openclaw-mdx-locales-");
  const config = path.join(root, "docs.json");
  writeFileSync(
    config,
    JSON.stringify({ navigation: { languages: [{ language: "fa" }, { language: "th" }] } }),
  );
  const result = spawnSync(process.execPath, [checkerPath, config], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
});

it("parses roots and output options", () => {
  expect(
    parseArgs(["docs", "README.md", "--json-out", "report.json", "--max-errors", "7"]),
  ).toEqual({
    roots: ["docs", "README.md"],
    jsonOut: "report.json",
    maxErrors: 7,
  });
});

it("rejects malformed max error limits", () => {
  for (const value of ["2x", "0"]) {
    expect(() => parseArgs(["--max-errors", value])).toThrow(
      "--max-errors must be a positive integer",
    );
  }
  for (const value of [[], ["-h"]]) {
    expect(() => parseArgs(["--max-errors", ...value])).toThrow("--max-errors requires a value");
  }
});

it("rejects missing JSON report output paths", () => {
  for (const value of [[], ["-h"], ["--max-errors", "3"]]) {
    expect(() => parseArgs(["--json-out", ...value])).toThrow("--json-out requires a value");
  }
});
