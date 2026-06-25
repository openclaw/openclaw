import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runCronCommandJob } from "./command-runner.js";
import type { CronJob } from "./types.js";

function makeCommandJob(payload: Extract<CronJob["payload"], { kind: "command" }>): CronJob {
  const now = Date.now();
  return {
    id: "command-job",
    name: "Command job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

describe("runCronCommandJob", () => {
  it("runs command argv and returns stdout as the deliverable summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('hello from cron')"],
        timeoutSeconds: 5,
      }),
      nowMs: () => 123,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello from cron");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 123,
      source: "exec",
      severity: "info",
      exitCode: 0,
    });
  });

  it("preserves exact NO_REPLY stdout for outbound suppression", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("NO_REPLY");
  });

  it("marks non-zero exit codes as cron errors and keeps stderr as summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stderr.write('bad thing'); process.exit(7)"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command exited with code 7");
    expect(result.summary).toBe("bad thing");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
      exitCode: 7,
    });
  });

  it("preserves action-critical auth prompts when command output is truncated", async () => {
    const script = [
      "process.stdout.write('To sign in, open https://login.microsoft.com/device and enter the code FAKE-CODE-270 to authenticate.\\n');",
      "process.stdout.write('early filler that should be omitted\\n');",
      "for (let i = 0; i < 80; i += 1) process.stdout.write(`CRON-FILLER-${i}-xxxxxxxxxxxxxxxxxxxxxxxx\\n`);",
      "process.stdout.write('DONE\\n');",
    ].join("");

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", script],
        timeoutSeconds: 5,
        outputMaxBytes: 120,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("https://login.microsoft.com/device");
    expect(result.summary).toContain("enter the code FAKE-CODE-270");
    expect(result.summary).toContain("[output truncated:");
    expect(result.summary).toContain("Recovery: openclaw cron runs --id command-job");
    expect(result.summary).toContain("DONE");
    expect(result.summary).not.toContain("early filler that should be omitted");
    expect(result.deliverySummary).toContain("DONE");
    expect(result.deliverySummary).not.toContain("https://login.microsoft.com/device");
    expect(result.diagnostics?.entries[0]?.truncated).toBe(true);
  });

  it("keeps non-actionable truncated output bounded to the captured tail", async () => {
    const script = [
      "process.stdout.write('first line should be dropped\\n');",
      "for (let i = 0; i < 80; i += 1) process.stdout.write(`noise-${i}-xxxxxxxxxxxxxxxxxxxxxxxx\\n`);",
      "process.stdout.write('tail marker\\n');",
    ].join("");

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", script],
        timeoutSeconds: 5,
        outputMaxBytes: 120,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("tail marker");
    expect(result.summary).toContain("[output truncated:");
    expect(result.summary).not.toContain("first line should be dropped");
  });

  it("marks command timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 0.05,
      }),
      nowMs: () => 456,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
    });
  });

  it.skipIf(process.platform === "win32")("kills shell process groups on timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
    const markerPath = path.join(tempDir, "survived");
    const childScript = [
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"), 350)`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const shellCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`;

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: ["sh", "-lc", shellCommand],
        timeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");

    await delay(700);
    await expect(fs.access(markerPath)).rejects.toThrow();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("marks no-output timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 5,
        noOutputTimeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command produced no output before noOutputTimeoutSeconds");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
    });
  });

  it("marks aborted command runs as cron errors", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('should not run')"],
        timeoutSeconds: 5,
      }),
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command stopped");
    expect(result.summary).toBeUndefined();
  });
});
