// Issue 78851 profiler CLI tests cover argument handling before work starts.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runProfiler(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/perf/issue-78851-model-resolution.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("issue 78851 model resolution profiler CLI", () => {
  it("prints help without starting the profiler", () => {
    const result = runProfiler("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw issue #78851 model-resolution profiler");
    expect(result.stdout).toContain(
      "node --import tsx scripts/perf/issue-78851-model-resolution.ts [options]",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects unknown arguments before starting the profiler", () => {
    const result = runProfiler("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
  });

  it("rejects partial numeric arguments before starting the profiler", () => {
    const result = runProfiler("--providers", "48junk");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--providers must be a positive integer");
  });

  it("rejects short flag values before starting the profiler", () => {
    const result = runProfiler("--providers", "-h");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--providers requires a value");
  });
});
