// Check Docs Mdx tests cover check docs mdx script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-mdx.mts";

describe("scripts/check-docs-mdx", () => {
  it("reuses only exact successful page checks and checks docs.json on warm runs", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mdx-cache-")));
    try {
      const checker = path.join(root, ".openclaw-sync", "check-docs-mdx.mts");
      fs.mkdirSync(path.join(root, ".openclaw-sync", "lib"), { recursive: true });
      for (const name of [
        "check-docs-mdx.mts",
        "lib/arg-utils.runtime.mjs",
        "lib/mintlify-accordion.mjs",
      ]) {
        fs.copyFileSync(path.join("scripts", name), path.join(root, ".openclaw-sync", name));
      }
      fs.symlinkSync(
        path.resolve("node_modules"),
        path.join(root, ".openclaw-sync", "node_modules"),
        "junction",
      );
      fs.mkdirSync(path.join(root, "node_modules"));
      // Synthetic requested/installed lock inputs; dependency code stays in the
      // read-only shared install. This fixture never runs npm.
      for (const name of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) {
        fs.writeFileSync(path.join(root, name), "{}\n");
      }
      fs.mkdirSync(path.join(root, "docs"));
      const page = path.join(root, "docs", "a.md");
      const config = path.join(root, "docs", "docs.json");
      const cache = path.join(root, "cache.json");
      const reportPath = path.join(root, "report.json");
      fs.writeFileSync(page, "# A\n");
      fs.writeFileSync(path.join(root, "docs", "b.mdx"), "# B\n");
      fs.writeFileSync(config, "{}");
      const run = (status = 0) => {
        const result = spawnSync(
          process.execPath,
          [checker, "docs", "--cache-file", cache, "--json-out", reportPath],
          { cwd: root, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(status);
        return JSON.parse(fs.readFileSync(reportPath, "utf8"));
      };
      expect(run().cacheHits).toBe(0);
      expect(run().cacheHits).toBe(2);
      const successful = fs.readFileSync(cache, "utf8");
      fs.writeFileSync(page, "---\nsummary: functions.exec\n---\n# A\n");
      expect(run(1).errors[0].type).toBe("poison-text");
      expect(fs.readFileSync(cache, "utf8")).toBe(successful);
      fs.writeFileSync(page, "# Changed\n");
      expect(run().cacheHits).toBe(1);
      fs.writeFileSync(config, '{"navigation":{"language":"unknown"}}');
      expect(run(1)).toMatchObject({ cacheHits: 2, errors: [{ type: "docs-json" }] });
      fs.writeFileSync(config, "{}");
      fs.unlinkSync(page);
      fs.renameSync(path.join(root, "docs", "b.mdx"), path.join(root, "docs", "b.MD"));
      expect(run().cacheHits).toBe(0);
      expect(Object.keys(JSON.parse(fs.readFileSync(cache, "utf8")).files)).toEqual(["docs/b.MD"]);
      for (const name of [
        ".openclaw-sync/check-docs-mdx.mts",
        ".openclaw-sync/lib/mintlify-accordion.mjs",
        "package-lock.json",
        "node_modules/.package-lock.json",
      ]) {
        fs.appendFileSync(path.join(root, name), "\n");
        expect(run().cacheHits).toBe(0);
      }
      fs.writeFileSync(cache, "{corrupt");
      expect(run().cacheHits).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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
