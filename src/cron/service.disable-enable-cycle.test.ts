import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CronJobCreate } from "./types.js";
import { CronService } from "./service.js";

describe("Cron disable/enable cycle (#10119)", () => {
  let service: CronService;
  let storePath: string;
  
  beforeEach(async () => {
    // Create temp store
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-test-"));
    storePath = path.join(tempDir, "cron.jsonl");
    
    service = new CronService({
      storePath,
      cronEnabled: true,
      enqueueSystemEvent: () => {},
      requestHeartbeatNow: () => {},
      runHeartbeatOnce: async () => ({ status: "skipped", reason: "test" }),
      runIsolatedAgentJob: async () => ({ status: "ok", summary: "test" }),
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as any,
      onEvent: () => {},
    });
    await service.start();
  });

  afterEach(async () => {
    service.stop();
    const storeDir = path.dirname(storePath);
    try {
      await fs.rm(storeDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("verifies fix for stuck state.running on disable/enable", async () => {
    // Create a job
    const job: CronJobCreate = {
      name: "test-job",
      schedule: { kind: "every", everyMs: 100 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "test" },
    };

    const created = await service.add(job);
    expect(created.enabled).toBe(true);

    // Disable then re-enable
    await service.update(created.id, { enabled: false });
    const reenabled = await service.update(created.id, { enabled: true });
    expect(reenabled.enabled).toBe(true);
    expect(reenabled.state.nextRunAtMs).toBeDefined();

    // Force run should succeed (verifies state.running not stuck)
    const result = await service.run(reenabled.id, "force");
    expect(result.ok).toBe(true);
    expect(result.ran).toBe(true);
  });
});
