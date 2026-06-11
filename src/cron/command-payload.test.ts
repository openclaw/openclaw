import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";

async function createStorePath(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    root,
    storePath: path.join(root, "cron", "jobs.json"),
  };
}

describe("cron command payloads", () => {
  const roots: string[] = [];

  beforeEach(() => {
    roots.length = 0;
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs a command payload directly without invoking an agent turn", async () => {
    const store = await createStorePath("openclaw-command-cron-ok-");
    roots.push(store.root);
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      cronEnabled: false,
      storePath: store.storePath,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "direct command proof",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "command",
          command: process.execPath,
          args: ["-e", "console.log('COMMAND_OK')"],
          timeoutSeconds: 5,
        },
        delivery: { mode: "none" },
      });

      const result = await cron.run(job.id, "force");
      const stored = cron.getJob(job.id);

      expect(result).toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(stored?.state.lastStatus).toBe("ok");
      expect(stored?.state.lastDiagnosticSummary).toContain("COMMAND_OK");
    } finally {
      cron.stop();
    }
  });

  it("records nonzero command exits as cron errors", async () => {
    const store = await createStorePath("openclaw-command-cron-fail-");
    roots.push(store.root);
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      cronEnabled: false,
      storePath: store.storePath,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "direct command failure proof",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "command",
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
          timeoutSeconds: 5,
        },
        delivery: { mode: "none" },
      });

      const result = await cron.run(job.id, "force");
      const stored = cron.getJob(job.id);

      expect(result).toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(stored?.state.lastStatus).toBe("error");
      expect(stored?.state.lastError).toBe("command exited with 7");
      expect(stored?.state.lastDiagnosticSummary).toContain("exit 7");
    } finally {
      cron.stop();
    }
  });
});
