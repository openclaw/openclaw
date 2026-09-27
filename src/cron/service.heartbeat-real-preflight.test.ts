// End-to-end proof for the heartbeat-skip accounting fix (#144959): the REAL
// heartbeat runner preflight reads a REAL comments-only scratch from the sqlite
// state store and skips the turn; the cron run must then settle as a successful
// no-op in both the run event and the task ledger (`tasks list --status failed`
// stays empty), with no injected heartbeat results anywhere in the path.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import {
  seedHeartbeatScratchForTest,
  seedMainSessionStore,
} from "../infra/heartbeat-runner.test-utils.js";
import {
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatsEnabled,
} from "../infra/heartbeat-wake.js";
import { enqueueSystemEventWithReceipt, resetSystemEventsForTest } from "../infra/system-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listTaskRecordsUnsorted } from "../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";

installHeartbeatRunnerTestRuntime();

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  resetTaskRegistryForTests();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("real heartbeat preflight task accounting", () => {
  it("settles a real empty-scratch preflight as a successful no-op task", async () => {
    const sandbox = tempDirs.make("openclaw-cron-real-preflight-");
    const cronStorePath = path.join(sandbox, "cron", "jobs.json");
    const sessionStorePath = path.join(sandbox, "sessions.json");
    // Point the default cron partition at the sandbox: the heartbeat preflight
    // resolves the store via OPENCLAW_STATE_DIR, so seeding and preflight must
    // land on the same partition for the comments-only scratch to be read.
    vi.stubEnv("OPENCLAW_STATE_DIR", sandbox);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: sandbox,
          heartbeat: { every: "30m", target: "telegram" },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: sessionStorePath },
    };
    const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
    await seedMainSessionStore(sessionStorePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });
    // Real monitor job whose scratch is the stock "keep me empty" file: the
    // preflight must classify it as empty-heartbeat-file and skip the turn.
    const heartbeatJobId = await seedHeartbeatScratchForTest({
      content: "<!-- Keep this file empty (or with only comments) to skip heartbeat API calls -->",
      storePath: cronStorePath,
    });

    const getReplySpy = vi.fn<(ctx: unknown) => Promise<{ text: string }>>(async () => ({
      text: "unexpected agent turn",
    }));
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
    const runHeartbeatOnceReal: typeof runHeartbeatOnce = (opts) =>
      runHeartbeatOnce({
        ...opts,
        cfg,
        deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
      });
    const heartbeatRunner = startHeartbeatRunner({ cfg, runOnce: runHeartbeatOnceReal });

    let resolveFinished: ((event: CronEvent) => void) | undefined;
    const finished = new Promise<CronEvent>((resolve) => {
      resolveFinished = resolve;
    });

    const cron = new CronService({
      storePath: cronStorePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: (text, opts) => {
        const sessionKey = opts?.sessionKey ?? mainSessionKey;
        const remove = enqueueSystemEventWithReceipt(text, {
          sessionKey,
          contextKey: opts?.contextKey,
        });
        return remove ? { accepted: true, remove } : { accepted: false };
      },
      requestHeartbeat: (opts) =>
        requestHeartbeat({ ...opts, sessionKey: opts.sessionKey ?? mainSessionKey }),
      requestHeartbeatAndWait: (opts, lifecycle) =>
        requestHeartbeatAndWait(
          { ...opts, sessionKey: opts.sessionKey ?? mainSessionKey, coalesceMs: 0 },
          lifecycle,
        ),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
      onEvent: (event) => {
        if (event.action === "finished" && event.jobId === heartbeatJobId) {
          resolveFinished?.(event);
        }
      },
    });
    await cron.start();

    const runPromise = cron.run(heartbeatJobId, "force");
    const finishedEvent = await finished;
    const runResult = await runPromise;
    expect(runResult).toMatchObject({ ok: true, ran: true });

    expect(finishedEvent).toMatchObject({
      status: "ok",
      completionStatus: "succeeded",
      summary: expect.stringContaining("heartbeat skipped: empty-heartbeat-file"),
    });
    // The agent turn must never have run: this distinguishes a real preflight
    // skip from an ordinary successful heartbeat that also settles as ok.
    expect(getReplySpy).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();

    // The task ledger that feeds `tasks list --status failed` must not
    // contain a failed row for this run.
    const failedCronTasks = listTaskRecordsUnsorted().filter(
      (task) => task.runtime === "cron" && task.status === "failed",
    );
    expect(failedCronTasks).toHaveLength(0);

    await cron.stop();
    heartbeatRunner.stop();
  });
});
