// Check Docs Mdx tests cover check docs mdx script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, walkMarkdownFiles } from "../../scripts/check-docs-mdx.mjs";

describe("scripts/check-docs-mdx", () => {
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

  it("skips symlinked markdown aliases", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-docs-mdx-"));
    try {
      const docsDir = path.join(tempDir, "docs");
      fs.mkdirSync(docsDir);
      const guidePath = path.join(docsDir, "guide.md");
      fs.writeFileSync(guidePath, "# Guide\n");
      try {
        fs.symlinkSync("missing.md", path.join(docsDir, "CLAUDE.md"), "file");
      } catch (error) {
        if (process.platform === "win32") {
          return;
        }
        throw error;
      }

      expect(walkMarkdownFiles(docsDir)).toEqual([path.resolve(guidePath)]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
