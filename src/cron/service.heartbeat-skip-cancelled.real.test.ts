// Regression for #145025: an intentional heartbeat no-op is recorded as a
// `cancelled` task — not a `failed` one. The chain is the REAL cron service +
// REAL heartbeat runner + REAL SQLite state + REAL task ledger: no mocks for
// the skip decision, the wake dispatch, or the ledger write.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import { seedMainSessionStore } from "../infra/heartbeat-runner.test-utils.js";
import {
  requestHeartbeatAndWait,
  setHeartbeatsEnabled,
} from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEventWithReceipt,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import {
  listTaskRegistryRecordsByRuntimeSourceIdFromSqlite,
  closeTaskRegistryDatabase,
  upsertTaskWithDeliveryStateToSqlite,
} from "../tasks/task-registry.store.sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

installHeartbeatRunnerTestRuntime();
beforeAll(async () => {
  // Load the real dispatch graph before the real-time scheduler fixture starts.
  await import("../auto-reply/dispatch.js");
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function runHeartbeatMonitorCase(
  options: { paused?: boolean },
  exercise: (fixture: {
    runJob: () => Promise<CronEvent>;
    cronStorePath: string;
    jobId: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = tempDirs.make("openclaw-proof-cron-skip-");
  const cronStorePath = path.join(dir, "cron", "jobs.json");
  const sessionStorePath = path.join(dir, "sessions.json");
  const getReplySpy = vi.fn(async (ctx: MsgContext) => {
    return { text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Handled" };
  });
  const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
  const requestHeartbeat = vi.fn();
  let resolveFinished: ((event: CronEvent) => void) | undefined;
  const finished = new Promise<CronEvent>((resolve) => {
    resolveFinished = resolve;
  });

  const cfg: OpenClawConfig = {
    cron: { store: cronStorePath },
    agents: {
      defaults: {
        workspace: dir,
        heartbeat: {
          every: "5m",
          target: "telegram",
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: sessionStorePath },
  };
  const expectedMainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
  await seedMainSessionStore(sessionStorePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
  });

  const runHeartbeatOnceReal: typeof runHeartbeatOnce = (opts) =>
    runHeartbeatOnce({
      ...opts,
      cfg,
      deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
    });

  const heartbeatRunner = startHeartbeatRunner({ cfg, runOnce: runHeartbeatOnceReal });
  const cron = new CronService({
    storePath: cronStorePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: (text, opts) => {
      const agentId = opts?.agentId ?? "main";
      const sessionKey = opts?.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId });
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey,
        contextKey: opts?.contextKey,
        deliveryContext: opts?.deliveryContext,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeat,
    requestHeartbeatAndWait: (opts, lifecycle) => {
      const sessionKey = opts.sessionKey ?? expectedMainSessionKey;
      return requestHeartbeatAndWait({ ...opts, sessionKey, coalesceMs: 0 }, lifecycle);
    },
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok",
    })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    onEvent: (event) => {
      if (event.action === "finished") {
        resolveFinished?.(event);
      }
    },
  });
  await cron.start();
  if (options.paused) {
    setHeartbeatsEnabled(false);
  }
  try {
    const added = await cron.add(
      {
        declarationKey: "heartbeat:main",
        name: "heartbeat-main",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "heartbeat" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      },
      { enabledExplicit: true, systemOwned: true },
    );
    const job = "job" in added ? added.job : added;
    if (!options.paused) {
      // Empty scratch: the real heartbeat runner's preflight skips before any
      // model turn (empty-heartbeat-file), so no provider is needed.
      await cron.writeScratch(job.id, { content: "" });
    }
    const runJob = async () => {
      const runPromise = cron.run(job.id, "force");
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("cron monitor run did not finish")), 20_000);
      });
      const terminal = await Promise.race([finished, timeout]);
      await runPromise;
      return terminal;
    };
    await exercise({ runJob, cronStorePath, jobId: job.id });
  } finally {
    cron.stop();
    heartbeatRunner.stop();
  }
}

describe("real cron scheduler + real heartbeat runner", () => {
  it(
    "keeps a disabled heartbeat skip a failed task, not a cancelled one",
    { timeout: 90_000 },
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-proof-cron-skip-" },
        async () => {
          resetTaskRegistryForTests();
          await runHeartbeatMonitorCase({ paused: true }, async ({ runJob, cronStorePath, jobId }) => {
            const terminal = await runJob();
            expect(terminal).toMatchObject({
              jobId,
              status: "skipped",
              error: "heartbeat skipped: disabled",
            });

            // A globally disabled heartbeat did not execute; it is an
            // unsuccessful run, not an intentional no-op, so it stays a failed
            // task for failure monitors.
            const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
              runtime: "cron",
              sourceId: jobId,
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              runtime: "cron",
              sourceId: jobId,
              status: "failed",
            });
            expect(rows[0]?.error).toBe("heartbeat skipped: disabled");

            const history = readCronTaskRunHistoryPage({
              storeKey: cronStoreKey(cronStorePath),
              jobId,
            }).entries;
            expect(history.some((entry) => entry.status === "skipped")).toBe(true);
          });
        },
      );
    },
  );

  it(
    "records an empty-heartbeat-file skip as a cancelled task, not a failed one",
    { timeout: 90_000 },
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-proof-cron-skip-" },
        async () => {
          resetTaskRegistryForTests();
          await runHeartbeatMonitorCase({ paused: false }, async ({ runJob, cronStorePath, jobId }) => {
            const terminal = await runJob();
            expect(terminal).toMatchObject({
              jobId,
              status: "skipped",
              error: "heartbeat skipped: empty-heartbeat-file",
            });

            // An intentional no-op (empty heartbeat file) is not a failure.
            const rows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
              runtime: "cron",
              sourceId: jobId,
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              runtime: "cron",
              sourceId: jobId,
              status: "cancelled",
            });
            expect(rows[0]?.error).toBe("heartbeat skipped: empty-heartbeat-file");
          });
        },
      );
    },
  );

  it(
    "keeps pre-existing failed rows failed across a restart while new no-op rows are cancelled",
    { timeout: 90_000 },
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-proof-cron-skip-" },
        async () => {
          resetTaskRegistryForTests();

          // A historical row recorded before this fix: a disabled-heartbeat
          // skip that was already projected to `failed`. It must not be
          // retroactively reclassified by the new code path (forward-only).
          const legacyTaskId = "task-cron-legacy-failed";
          upsertTaskWithDeliveryStateToSqlite({
            task: {
              taskId: legacyTaskId,
              runtime: "cron",
              sourceId: "heartbeat:main:legacy",
              requesterSessionKey: "agent:main:main",
              ownerKey: "agent:main:main",
              scopeKind: "system",
              runId: "run-cron-legacy",
              task: "legacy heartbeat monitor run",
              status: "failed",
              deliveryStatus: "pending",
              notifyPolicy: "done_only",
              createdAt: 1,
              endedAt: 2,
              error: "heartbeat skipped: disabled",
            },
          });

          await runHeartbeatMonitorCase(
            { paused: false },
            async ({ runJob, cronStorePath, jobId }) => {
              const terminal = await runJob();
              expect(terminal).toMatchObject({
                jobId,
                status: "skipped",
                error: "heartbeat skipped: empty-heartbeat-file",
              });

              // The new no-op row is cancelled; the legacy failed row is untouched.
              const newRows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
                runtime: "cron",
                sourceId: jobId,
              });
              expect(newRows).toHaveLength(1);
              expect(newRows[0]).toMatchObject({
                runtime: "cron",
                sourceId: jobId,
                status: "cancelled",
              });
              const legacyRows = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
                runtime: "cron",
                sourceId: "heartbeat:main:legacy",
              });
              expect(legacyRows).toHaveLength(1);
              expect(legacyRows[0]).toMatchObject({
                taskId: legacyTaskId,
                status: "failed",
              });
              expect(legacyRows[0]?.error).toBe("heartbeat skipped: disabled");

              // Simulate a process restart: drop the cached DB and re-read the
              // rows straight from SQLite. Both classifications persist.
              closeTaskRegistryDatabase();
              const newRowsAfterRestart = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
                runtime: "cron",
                sourceId: jobId,
              });
              const legacyRowsAfterRestart = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
                runtime: "cron",
                sourceId: "heartbeat:main:legacy",
              });
              expect(newRowsAfterRestart).toHaveLength(1);
              expect(newRowsAfterRestart[0]).toMatchObject({
                runtime: "cron",
                sourceId: jobId,
                status: "cancelled",
              });
              expect(legacyRowsAfterRestart).toHaveLength(1);
              expect(legacyRowsAfterRestart[0]).toMatchObject({
                taskId: legacyTaskId,
                status: "failed",
              });
            },
          );
        },
      );
    },
  );
});
