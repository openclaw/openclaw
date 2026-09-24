// Check Docs Mdx tests cover check docs mdx script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-mdx.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const checkerPath = path.resolve(import.meta.dirname, "../../scripts/check-docs-mdx.mjs");

describe("scripts/check-docs-mdx", () => {
  it.each([
    {
      name: "plain component",
      prefix: "",
      body: "<Note>\n  </Note>\n",
      error: { type: "mintlify-mdx", line: 2, column: 3 },
    },
    {
      name: "LF frontmatter",
      prefix: "---\ntitle: Example\n---\n",
      body: "<Note>\n  </Note>\n",
      error: { type: "mintlify-mdx", line: 5, column: 3 },
    },
    {
      name: "CRLF frontmatter",
      prefix: "---\r\ntitle: Example\r\n---\r\n",
      body: "<Note>\r\n  </Note>\r\n",
      error: { type: "mintlify-mdx", line: 5, column: 3 },
    },
    {
      name: "YAML document-end delimiter",
      prefix: "---\ntitle: Example\n...\n",
      body: "<Note>\n  </Note>\n",
      error: { type: "mintlify-mdx", line: 5, column: 3 },
    },
    {
      name: "LF MDX expression",
      prefix: "---\ntitle: Example\n---\n",
      body: "{\n",
      error: { type: "mdx", line: 5, column: 1 },
    },
    {
      name: "CRLF MDX expression",
      prefix: "---\r\ntitle: Example\r\n---\r\n",
      body: "{\r\n",
      error: { type: "mdx", line: 5, column: 1 },
    },
    {
      name: "valid LF document",
      prefix: "---\ntitle: Example\n---\n",
      body: "# Valid\n",
      error: null,
    },
    {
      name: "valid CRLF document",
      prefix: "---\r\ntitle: Example\r\n---\r\n",
      body: "# Valid\r\n",
      error: null,
    },
  ])("reports original source locations for $name", ({ prefix, body, error }) => {
    const root = createTempDir("openclaw-mdx-source-lines-");
    const sourcePath = path.join(root, "page.mdx");
    const reportPath = path.join(root, "report.json");
    writeFileSync(sourcePath, prefix + body);

    const result = spawnSync(
      process.execPath,
      [checkerPath, sourcePath, "--json-out", reportPath],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

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
    expect(() => parseArgs(["--max-errors", "2x"])).toThrow(
      "--max-errors must be a positive integer",
    );
    expect(() => parseArgs(["--max-errors", "0"])).toThrow(
      "--max-errors must be a positive integer",
    );
    expect(() => parseArgs(["--max-errors"])).toThrow("--max-errors requires a value");
    expect(() => parseArgs(["--max-errors", "-h"])).toThrow("--max-errors requires a value");
  });

  it("rejects missing JSON report output paths", () => {
    expect(() => parseArgs(["--json-out"])).toThrow("--json-out requires a value");
    expect(() => parseArgs(["--json-out", "-h"])).toThrow("--json-out requires a value");
    expect(() => parseArgs(["--json-out", "--max-errors", "3"])).toThrow(
      "--json-out requires a value",
    );
  });
});
