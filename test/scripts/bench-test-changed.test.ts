// Bench Test Changed tests cover bench test changed script behavior.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatRss, parseMaxRssBytes } from "../../scripts/bench-test-changed.mjs";

function runBenchTestChanged(args: string[]) {
  return spawnSync(process.execPath, ["scripts/bench-test-changed.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("bench-test-changed script", () => {
  it("formats macOS time RSS bytes as MiB", () => {
    expect(parseMaxRssBytes("  2097152  maximum resident set size\n")).toBe(2_097_152);
    expect(formatRss(2_097_152)).toBe("2.0MB");
    expect(formatRss(-1_048_576)).toBe("-1.0MB");
  });

  it("rejects malformed max worker values before inspecting git state", () => {
    const malformed = runBenchTestChanged(["--max-workers", "2abc"]);

    expect(malformed.status).toBe(1);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toContain("--max-workers must be a positive integer");
    expect(malformed.stderr).not.toContain("at ");

    const fractional = runBenchTestChanged(["--max-workers", "1.5"]);

    expect(fractional.status).toBe(1);
    expect(fractional.stdout).toBe("");
    expect(fractional.stderr).toContain("--max-workers must be a positive integer");
    expect(fractional.stderr).not.toContain("at ");
  });

  it("rejects missing max worker values before inspecting git state", () => {
    const result = runBenchTestChanged(["--max-workers"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--max-workers requires a value");
    expect(result.stderr).not.toContain("at ");
  });
});
