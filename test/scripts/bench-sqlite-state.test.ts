// Bench SQLite State tests cover benchmark CLI argument safety.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runBench(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-sqlite-state.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("scripts/bench-sqlite-state", () => {
  it("rejects unknown args before seeding benchmark databases", () => {
    const result = runBench(["--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: Unknown argument: --wat");
  });

  it("rejects missing output values before seeding benchmark databases", () => {
    const result = runBench(["--output", "--profile", "smoke"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: --output requires a value");
  });

  it("rejects invalid profiles without printing a stack trace", () => {
    const result = runBench(["--profile", "huge"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      'error: --profile must be one of smoke, default, large; got "huge"',
    );
  });
});
