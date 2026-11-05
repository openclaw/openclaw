// Bench Web Fetch tests cover the offline benchmark CLI contract.
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const SCRIPT_PATH = "scripts/bench-web-fetch.ts";
const it = createCommandTest();

async function runBenchWebFetch(command: CommandFixture, ...args: string[]) {
  const result = await command.run(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FIRECRAWL_API_KEY: "test-firecrawl-key-that-should-be-ignored",
      NODE_NO_WARNINGS: "1",
    },
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe("web fetch benchmark script", () => {
  it.concurrent("accepts the package-manager separator documented for pnpm scripts", async ({
    command,
  }) => {
    const result = await runBenchWebFetch(
      command,
      "--",
      "--case",
      "tool-create",
      "--runs",
      "1",
      "--warmup",
      "0",
      "--json",
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      cases: Array<{ id: string; samplesMs: number[] }>;
    };
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      id: "tool-create",
      samplesMs: expect.any(Array),
    });
    expect(report.cases[0]?.samplesMs).toHaveLength(1);
  });

  it.concurrent("rejects duplicate singular flags without a stack trace", async ({ command }) => {
    const result = await runBenchWebFetch(command, "--runs", "1", "--runs", "2");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--runs was provided more than once");
    expect(result.stderr).not.toContain("\n    at ");
  });

  it.concurrent.for<readonly [string, string, string]>([
    ["--runs", "1e3", "--runs must be a positive integer"],
    ["--warmup", "1e3", "--warmup must be a non-negative integer"],
    ["--runs", "9007199254740993", "--runs must be a positive integer"],
    ["--warmup", "9007199254740993", "--warmup must be a non-negative integer"],
  ])("rejects invalid benchmark count %s %s", async ([flag, value, expectedError], { command }) => {
    const result = await runBenchWebFetch(command, flag, value);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(expectedError);
    expect(result.stderr).not.toContain("\n    at ");
  });
});
