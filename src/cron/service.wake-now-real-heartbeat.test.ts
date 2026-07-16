// Scheduler-level proof for #105257: the real CronService drives the real heartbeat
// runner, so the job's own active marker (set by the scheduler) meets the real busy
// guard. Every other cron test stubs runHeartbeatOnce, which hides that interaction:
// pre-fix the guard self-tripped, cron took its async fallback, and the run was
// reported ok without the queued event ever being delivered.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "../infra/heartbeat-runner.test-utils.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { CronService } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";

setupTelegramHeartbeatPluginRuntimeForTests();

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-real-heartbeat-"));
  return {
    dir,
    cronStorePath: path.join(dir, "cron", "jobs.json"),
    sessionStorePath: path.join(dir, "sessions.json"),
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

describe("wakeMode:now main cron with the real heartbeat runner (#105257)", () => {
  it("runs the turn synchronously instead of falling back to an unconfirmed async wake", async () => {
    const sandbox = await makeSandbox();
    const getReplySpy = vi.fn().mockResolvedValue({ text: "Handled the reminder" });
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
    const requestHeartbeat = vi.fn();

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: sandbox.dir,
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: sandbox.sessionStorePath },
    };
    await seedMainSessionStore(sandbox.sessionStorePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });

    // The model call is the only mocked boundary; the busy guard, the active-job
    // marker, and the system-event queue are all real.
    const runHeartbeatOnceReal: NonNullable<CronServiceDeps["runHeartbeatOnce"]> = (opts) =>
      runHeartbeatOnce({
        ...opts,
        cfg,
        deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
      });

    const cron = new CronService({
      storePath: sandbox.cronStorePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: (text, opts) => {
        const event = enqueueSystemEventEntry(text, {
          sessionKey: opts?.sessionKey as string,
          contextKey: opts?.contextKey,
          deliveryContext: opts?.deliveryContext,
        });
        return event
          ? {
              accepted: true,
              remove: () =>
                consumeSelectedSystemEventEntries(opts?.sessionKey as string, [event]).length > 0,
            }
          : { accepted: false };
      },
      requestHeartbeat,
      runHeartbeatOnce: runHeartbeatOnceReal,
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    });
    await cron.start();

    try {
      // Scheduled far ahead so only the explicit forced run fires: an already-due job
      // would race the running scheduler's own timer against cron.run below.
      const job = await cron.add({
        enabled: true,
        name: "nightly report",
        schedule: { kind: "at", at: new Date(Date.now() + 60 * 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "Reminder: Send the nightly report" },
      });

      await cron.run(job.id, "force");

      // Pre-fix the job's own marker tripped the guard, so the turn never ran here and
      // cron queued an unconfirmed async wake instead while still reporting ok.
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      expect(requestHeartbeat).not.toHaveBeenCalled();

      // Assert the cron payload actually reached the model on the job's own per-run
      // session key. A bare heartbeat turn would satisfy the call count above.
      const [ctx] = getReplySpy.mock.calls[0] ?? [];
      const replyCtx = ctx as { Provider?: string; SessionKey?: string; Body?: string };
      expect(replyCtx.Provider).toBe("cron-event");
      expect(replyCtx.SessionKey).toContain(`:cron:${job.id}:run:`);
      expect(replyCtx.Body).toContain("Reminder: Send the nightly report");
    } finally {
      await cron.stop();
      await sandbox.cleanup();
    }
  });
});
