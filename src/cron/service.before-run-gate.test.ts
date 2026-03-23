import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CronService, type CronServiceDeps } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-before-run-" });

let scriptDir: string;

beforeAll(async () => {
  scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-gate-scripts-"));
});

afterAll(async () => {
  if (scriptDir) {
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
});

async function writeGateScript(name: string, body: string): Promise<string> {
  const scriptPath = path.join(scriptDir, name);
  await fs.writeFile(scriptPath, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return scriptPath;
}

async function withCronService(
  params: {
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (ctx: { cron: CronService; runIsolatedAgentJob: ReturnType<typeof vi.fn> }) => Promise<void>,
) {
  const { storePath } = await makeStorePath();
  const runIsolatedAgentJob =
    params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
  const cron = new CronService({
    cronEnabled: false,
    storePath,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: runIsolatedAgentJob as CronServiceDeps["runIsolatedAgentJob"],
  });
  await cron.start();
  try {
    await run({ cron, runIsolatedAgentJob: runIsolatedAgentJob as ReturnType<typeof vi.fn> });
  } finally {
    cron.stop();
  }
}

async function addJobWithBeforeRun(cron: CronService, beforeRun?: string) {
  return cron.add({
    name: `gate-test-${Date.now()}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
    sessionTarget: "isolated",
    wakeMode: "now",
    beforeRun,
    payload: { kind: "agentTurn", message: "test message" },
    delivery: { mode: "announce" },
  });
}

describe("cron beforeRun gate", () => {
  it("proceeds with LLM when beforeRun script exits 0", async () => {
    const script = await writeGateScript("pass.sh", "exit 0");
    await withCronService({}, async ({ cron, runIsolatedAgentJob }) => {
      const job = await addJobWithBeforeRun(cron, script);
      const result = await cron.run(job.id, "force");
      expect(result).toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalled();
    });
  });

  it("skips LLM when beforeRun script exits non-zero", async () => {
    const script = await writeGateScript("reject.sh", "exit 2");
    await withCronService({}, async ({ cron, runIsolatedAgentJob }) => {
      const job = await addJobWithBeforeRun(cron, script);
      const result = await cron.run(job.id, "force");
      expect(result).toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    });
  });

  it("skips LLM when beforeRun script exits with code 1", async () => {
    const script = await writeGateScript("error.sh", "exit 1");
    await withCronService({}, async ({ cron, runIsolatedAgentJob }) => {
      const job = await addJobWithBeforeRun(cron, script);
      const result = await cron.run(job.id, "force");
      expect(result).toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    });
  });

  it("skips LLM when beforeRun script does not exist", async () => {
    await withCronService({}, async ({ cron, runIsolatedAgentJob }) => {
      const job = await addJobWithBeforeRun(cron, "/nonexistent/gate.sh");
      const result = await cron.run(job.id, "force");
      expect(result).toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    });
  });

  it("runs LLM normally when no beforeRun is configured", async () => {
    await withCronService({}, async ({ cron, runIsolatedAgentJob }) => {
      const job = await addJobWithBeforeRun(cron, undefined);
      const result = await cron.run(job.id, "force");
      expect(result).toMatchObject({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalled();
    });
  });

  it("passes job id as first argument to the gate script", async () => {
    const markerPath = path.join(scriptDir, "arg-marker.txt");
    const script = await writeGateScript("check-arg.sh", `echo "$1" > "${markerPath}"\nexit 0`);
    await withCronService({}, async ({ cron }) => {
      const job = await addJobWithBeforeRun(cron, script);
      await cron.run(job.id, "force");
      const received = (await fs.readFile(markerPath, "utf-8")).trim();
      expect(received).toBe(job.id);
    });
  });

  it("sets CRON_JOB_ID env var for the gate script", async () => {
    const markerPath = path.join(scriptDir, "env-marker.txt");
    const script = await writeGateScript(
      "check-env.sh",
      `echo "$CRON_JOB_ID" > "${markerPath}"\nexit 0`,
    );
    await withCronService({}, async ({ cron }) => {
      const job = await addJobWithBeforeRun(cron, script);
      await cron.run(job.id, "force");
      const received = (await fs.readFile(markerPath, "utf-8")).trim();
      expect(received).toBe(job.id);
    });
  });

  it("logs info when gate passes", async () => {
    const script = await writeGateScript("log-pass.sh", "exit 0");
    logger.info.mockClear();
    await withCronService({}, async ({ cron }) => {
      const job = await addJobWithBeforeRun(cron, script);
      await cron.run(job.id, "force");
      const gatePassCall = logger.info.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1].includes("beforeRun gate passed"),
      );
      expect(gatePassCall).toBeDefined();
    });
  });

  it("logs info when gate rejects", async () => {
    const script = await writeGateScript("log-reject.sh", "exit 2");
    logger.info.mockClear();
    await withCronService({}, async ({ cron }) => {
      const job = await addJobWithBeforeRun(cron, script);
      await cron.run(job.id, "force");
      const gateRejectCall = logger.info.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1].includes("beforeRun gate rejected"),
      );
      expect(gateRejectCall).toBeDefined();
    });
  });

  it("logs rejection when gate script path does not exist", async () => {
    logger.info.mockClear();
    await withCronService({}, async ({ cron }) => {
      const job = await addJobWithBeforeRun(cron, "/nonexistent/gate.sh");
      await cron.run(job.id, "force");
      // bash itself is found but exits non-zero because the script doesn't exist,
      // so this is logged as a gate rejection rather than ENOENT.
      const rejectCall = logger.info.mock.calls.find(
        (args: unknown[]) =>
          typeof args[1] === "string" && args[1].includes("beforeRun gate rejected"),
      );
      expect(rejectCall).toBeDefined();
    });
  });
});
