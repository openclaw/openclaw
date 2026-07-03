// Bench Model tests cover live model benchmark CLI safety.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-model.ts";

function runBenchModel(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/bench-model.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
  });
}

describe("scripts/bench-model", () => {
  it("parses benchmark options without importing live credentials", () => {
    expect(testing.parseArgs(["--runs", "2", "--prompt", "ping"])).toMatchObject({
      help: false,
      prompt: "ping",
      runs: 2,
    });
  });

  it("rejects unknown args before checking provider credentials", () => {
    expect(() => testing.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const result = runBenchModel(["--wat"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown argument: --wat");
    expect(result.stderr).not.toContain("Missing ANTHROPIC_API_KEY");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("rejects malformed run counts instead of silently using defaults", () => {
    expect(() => testing.parseArgs(["--runs", "1e3"])).toThrow("--runs must be an integer");

    const result = runBenchModel(["--runs", "1e3"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--runs must be an integer");
    expect(result.stderr).not.toContain("Missing ANTHROPIC_API_KEY");
  });

  it("rejects short flag values before checking provider credentials", () => {
    expect(() => testing.parseArgs(["--prompt", "-h"])).toThrow("--prompt requires a value");
    expect(() => testing.parseArgs(["--runs", "-h"])).toThrow("--runs requires a value");

    const result = runBenchModel(["--prompt", "-h"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--prompt requires a value");
    expect(result.stderr).not.toContain("Missing ANTHROPIC_API_KEY");
  });

  it("rejects duplicate value flags before checking provider credentials", () => {
    expect(() => testing.parseArgs(["--runs", "1", "--runs", "2"])).toThrow(
      "--runs was provided more than once",
    );

    const result = runBenchModel(["--runs", "1", "--runs", "2"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs was provided more than once");
    expect(result.stderr).not.toContain("Missing ANTHROPIC_API_KEY");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it("prints help without checking provider credentials", () => {
    const result = runBenchModel(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OpenClaw model latency benchmark");
    expect(result.stderr).toBe("");
  });
});
