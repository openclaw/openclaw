import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("skills/tmux/scripts/find-sessions.sh");

function run(args: string[]) {
  return execFileAsync("bash", [scriptPath, ...args], {
    timeout: 10_000,
    // Missing values are rejected before any tmux lookup, so a real tmux server
    // (or its absence) never affects these assertions.
  });
}

describe("tmux find-sessions value options", () => {
  it.each([
    { args: ["-L"], option: "-L" },
    { args: ["--socket"], option: "--socket" },
    { args: ["-S"], option: "-S" },
    { args: ["--socket-path"], option: "--socket-path" },
    { args: ["-q"], option: "-q" },
    { args: ["--query"], option: "--query" },
    { args: ["-L", "--socket"], option: "-L" },
    { args: ["-q", "--all"], option: "-q" },
    { args: ["-S", "--help"], option: "-S" },
  ])("reports a missing value for $option", async ({ args, option }) => {
    await expect(run(args)).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(`${option} requires a value`),
    });
  });

  it.each([
    { args: ["-L", "mysocket"] },
    { args: ["--socket", "mysocket"] },
    { args: ["-S", "/tmp/sock"] },
    { args: ["--socket-path", "/tmp/sock"] },
    { args: ["-q", "myquery"] },
    { args: ["--query", "myquery"] },
    // A value that starts with '-' but is not a known option is a real value.
    { args: ["-q", "--foo"] },
  ])("accepts a provided value for $args", async ({ args }) => {
    const result: unknown = await run(args).catch((error: unknown) => error);
    const code = (result as { code?: number }).code;
    const stderr = (result as { stderr?: string }).stderr ?? "";
    expect(code).not.toBe(2);
    expect(stderr).not.toContain("requires a value");
  });

  it("keeps help exiting zero", async () => {
    const { stdout } = await run(["-h"]);
    expect(stdout).toContain("Usage:");
  });
});
