import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/profile-extension-memory.mjs");

function runProfileExtensionMemory(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("scripts/profile-extension-memory", () => {
  it("prints help without requiring built plugin artifacts", () => {
    const result = runProfileExtensionMemory(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/profile-extension-memory.mjs");
  });

  it("rejects loose numeric flags before scanning built plugin artifacts", () => {
    const cases = [
      ["--concurrency", "2abc"],
      ["--timeout-ms", "1e3"],
      ["--combined-timeout-ms", "90000ms"],
      ["--top", "0x10"],
    ];

    for (const [flag, value] of cases) {
      const result = runProfileExtensionMemory([flag, value]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`[extension-memory] ${flag} must be a positive integer`);
      expect(result.stderr).not.toContain("dist/extensions");
      expect(result.stderr).not.toContain("at ");
    }
  });

  it("bounds noisy child output without losing RSS samples", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-extension-memory-test-"));
    try {
      const extensionDir = path.join(root, "dist", "extensions", "noisy");
      const reportPath = path.join(root, "report.json");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "index.js"),
        [
          `const fs = require("node:fs");`,
          `fs.writeSync(2, "old stderr " + "x".repeat(160000) + "\\n");`,
          `fs.writeSync(1, "old stdout " + "y".repeat(160000) + "\\n");`,
          `process.on("exit", () => fs.writeSync(2, "exit tail\\n"));`,
        ].join("\n"),
        "utf8",
      );

      const result = runProfileExtensionMemory(
        ["--extension", "noisy", "--skip-combined", "--concurrency", "1", "--json", reportPath],
        root,
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.results).toHaveLength(1);
      expect(report.results[0].status).toBe("ok");
      expect(report.results[0].maxRssMb).toEqual(expect.any(Number));
      expect(report.results[0].stderrPreview).toContain("[output truncated");
      expect(report.results[0].stderrPreview).toContain("[stderr preview truncated");
      expect(report.results[0].stderrPreview).toContain("exit tail");
      expect(report.results[0].stderrPreview).not.toContain("old stderr");
      expect(report.results[0].stderrPreview.length).toBeLessThan(9_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
