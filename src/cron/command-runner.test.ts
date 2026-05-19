import { describe, expect, it, vi } from "vitest";
import { mapCronCommandOutput, runCronCommandPayload } from "./command-runner.js";
import type { CronJob } from "./types.js";

function makeCommandJob(payload: CronJob["payload"], delivery?: CronJob["delivery"]): CronJob {
  return {
    id: "command-job",
    name: "command job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    delivery: delivery ?? { mode: "announce", channel: "telegram", to: "123" },
    state: {},
  };
}

describe("cron command runner", () => {
  it("maps JSON urgent entries to one announce payload", async () => {
    const deliverAnnouncement = vi.fn(async () => undefined);
    const result = await runCronCommandPayload({
      job: makeCommandJob({
        kind: "command",
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ ok: true, urgent: ['Invoice due', 'Contract signing'] }))",
        ],
        output: "json",
      }),
      deliverAnnouncement,
    });

    expect(result.status).toBe("ok");
    expect(result.delivered).toBe(true);
    expect(result.deliveryAttempted).toBe(true);
    expect(result.summary).toBe("Invoice due\n\nContract signing");
    expect(deliverAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Invoice due\n\nContract signing",
        plan: expect.objectContaining({ mode: "announce", channel: "telegram", to: "123" }),
      }),
    );
  });

  it("keeps quiet JSON output silent", async () => {
    const deliverAnnouncement = vi.fn(async () => undefined);
    const result = await runCronCommandPayload({
      job: makeCommandJob({
        kind: "command",
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({ ok: true, urgent: [] }))"],
        output: "json",
      }),
      deliverAnnouncement,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBeUndefined();
    expect(result.deliveryAttempted).toBe(false);
    expect(deliverAnnouncement).not.toHaveBeenCalled();
  });

  it("treats ok=false JSON as a failed command result", () => {
    expect(
      mapCronCommandOutput({
        stdout: JSON.stringify({ ok: false, error: "mail queue crashed" }),
        outputMode: "json",
      }),
    ).toEqual({
      status: "error",
      error: "mail queue crashed",
      summary: "mail queue crashed",
      notificationText: "mail queue crashed",
    });
  });

  it("reports non-zero exits as exec failures", async () => {
    const result = await runCronCommandPayload({
      job: makeCommandJob(
        {
          kind: "command",
          command: process.execPath,
          args: ["-e", "console.error('bad'); process.exit(7)"],
        },
        { mode: "none" },
      ),
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("exit code 7");
    expect(result.diagnostics?.entries[0]?.source).toBe("exec");
    expect(result.diagnostics?.entries[0]?.exitCode).toBe(7);
  });
});
