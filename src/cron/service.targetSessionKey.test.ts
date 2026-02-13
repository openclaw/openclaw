import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-tskey-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService targetSessionKey", () => {
  it("passes targetSessionKey to enqueueSystemEvent for main jobs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 10 }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });
    await cron.start();
    const job = await cron.add({
      name: "targeted-main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Check QA" },
      targetSessionKey: "agent:main:slack:C123:thread:1770906236.804979",
    });

    const result = await cron.run(job.id, "force");
    expect(result).toEqual({ ok: true, ran: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Check QA", {
      agentId: undefined,
      sessionKey: "agent:main:slack:C123:thread:1770906236.804979",
    });

    cron.stop();
    await store.cleanup();
  });

  it("passes sessionKey to runHeartbeatOnce for wakeMode=now", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 10 }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });
    await cron.start();
    const job = await cron.add({
      name: "targeted-heartbeat",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
      targetSessionKey: "agent:main:slack:C123:thread:xxx",
    });

    await cron.run(job.id, "force");
    expect(runHeartbeatOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        sessionKey: "agent:main:slack:C123:thread:xxx",
      }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("rejects targetSessionKey for isolated jobs", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });
    await cron.start();
    await expect(
      cron.add({
        name: "bad-isolated",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hi" },
        targetSessionKey: "some-key",
      }),
    ).rejects.toThrow(/targetSessionKey.*main/i);

    cron.stop();
    await store.cleanup();
  });

  it("rejects targetSessionKey with wakeMode=next-heartbeat", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done" })),
    });
    await cron.start();
    await expect(
      cron.add({
        name: "bad-heartbeat",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hi" },
        targetSessionKey: "some-key",
      }),
    ).rejects.toThrow(/targetSessionKey.*now/i);

    cron.stop();
    await store.cleanup();
  });
});
