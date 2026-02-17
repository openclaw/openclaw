import { describe, expect, it } from "vitest";
import { runCronDirectCommand } from "./direct-command.js";

function parseSummary(summary: string | undefined) {
  expect(summary).toBeTruthy();
  return JSON.parse(summary ?? "{}") as {
    status: "ok" | "error" | "skipped";
    summary: string;
    captured: { stdout: string; stderr: string };
  };
}

describe("runCronDirectCommand", () => {
  it("executes argv commands without shell interpolation", async () => {
    const result = await runCronDirectCommand({
      jobId: "job-1",
      payload: {
        kind: "directCommand",
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", "hello world"],
      },
    });

    expect(result.status).toBe("ok");
    const parsed = parseSummary(result.summary);
    expect(parsed).toEqual({
      status: "ok",
      summary: "hello world",
      captured: {
        stdout: "hello world",
        stderr: "",
      },
    });
  });

  it("returns an error for non-zero exits", async () => {
    const result = await runCronDirectCommand({
      jobId: "job-2",
      payload: {
        kind: "directCommand",
        command: process.execPath,
        args: ["-e", "process.stderr.write('boom'); process.exit(4)"],
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("code 4");
    const parsed = parseSummary(result.summary);
    expect(parsed.status).toBe("error");
    expect(parsed.summary).toContain("boom");
    expect(parsed.captured.stderr).toContain("boom");
  });

  it("times out long-running commands", async () => {
    const result = await runCronDirectCommand({
      jobId: "job-timeout",
      payload: {
        kind: "directCommand",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutSeconds: 0.5,
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("timed out");
    expect(result.error).toContain("500ms");
  });

  it("truncates output when exceeding maxOutputBytes", async () => {
    const longOutput = "a".repeat(1000);
    const result = await runCronDirectCommand({
      jobId: "job-truncate",
      payload: {
        kind: "directCommand",
        command: process.execPath,
        args: ["-e", `process.stdout.write("${longOutput}")`],
        maxOutputBytes: 50,
      },
    });

    expect(result.status).toBe("ok");
    const parsed = parseSummary(result.summary);
    expect(parsed.summary.length).toBeLessThanOrEqual(50);
    expect(parsed.captured.stdout).toMatch(/^a+$/);
  });
});
