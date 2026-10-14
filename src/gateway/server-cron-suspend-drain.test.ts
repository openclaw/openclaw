// Proves a failing cron drain during Gateway suspend/resume is observed, not fatal,
// and that the Gateway stays responsive after the fault.
import { expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import { CronService } from "../cron/service.js";
import { saveCronStore } from "../cron/store.js";
import { resetGatewaySuspendCoordinatorForLifecycleRestart } from "../infra/gateway-suspend-coordinator.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { dispatchSuspensionRequest } from "./server-methods.suspension-admission.test-support.js";
import { suspendHandlers } from "./server-methods/suspend.js";

const NOW = Date.parse("2026-10-15T00:00:00.000Z");
const MAX_CONCURRENT = 8;

function createGatewayLogger() {
  const calls: unknown[][] = [];
  return {
    logGateway: {
      warn: vi.fn((...args: unknown[]) => {
        calls.push(args);
      }),
      info: vi.fn(),
    },
    calls,
  };
}

it("keeps the Gateway responsive when a suspended resume drain fails", async ({ signal }) => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cron-drain-"));
  const storePath = path.join(root, "cron", "jobs.json");
  await (await import("node:fs/promises")).mkdir(path.dirname(storePath), { recursive: true });

  const blockers = Array.from({ length: MAX_CONCURRENT }, (_, index) =>
    createDueIsolatedJob({ id: `blocker-${index}`, nowMs: NOW, nextRunAtMs: NOW + 60_000 }),
  );
  const queued = createDueIsolatedJob({
    id: "queued-on-resume",
    nowMs: NOW,
    nextRunAtMs: NOW + 60_000,
  });
  await saveCronStore(storePath, { version: 1, jobs: [...blockers, queued] });

  let releaseBlockers = () => {};
  const held = new Promise<void>((resolve) => {
    releaseBlockers = resolve;
  });
  let started = 0;
  let allStarted = () => {};
  const allStartedPromise = new Promise<void>((resolve) => {
    allStarted = resolve;
  });

  const logger = createGatewayLogger();
  const cronLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => NOW,
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: cronLog,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async ({ job }) => {
      if (job.id.startsWith("blocker-")) {
        started += 1;
        if (started === MAX_CONCURRENT) {
          allStarted();
        }
        await held;
      }
      return { status: "ok" };
    },
    runCommandJob: async () => ({ status: "ok" }),
  });

  const unhandled: unknown[] = [];
  const observe = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", observe);
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  const failure = new Error("cron state database is damaged");

  try {
    await cron.start();
    for (const blocker of blockers) {
      await cron.enqueueRun(blocker.id, "force");
    }
    await Promise.race([
      allStartedPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("blockers did not start")), 10_000);
      }),
    ]);
    // A queued request waits behind the occupied concurrency slots.
    await cron.enqueueRun(queued.id, "force");

    const context = {
      getRuntimeConfig: () => ({}),
      cron,
      logGateway: logger.logGateway,
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions: { size: 0 },
    } as unknown as Parameters<typeof dispatchSuspensionRequest>[0]["context"];

    const prepared = dispatchSuspensionRequest({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: suspendHandlers["gateway.suspend.prepare"]!,
      requestParams: { requestId: "proof-suspend", terminalPolicy: "preserve", drain: true },
      context,
    });
    await prepared.request;
    const preparedPayload = prepared.respond.mock.calls.at(-1)?.[1] as
      | { suspensionId?: string }
      | undefined;
    expect(preparedPayload?.suspensionId, "suspension was armed").toBeTypeOf("string");

    // A damaged store latches every later open, so resume's drain rejects once.
    recordOpenClawStateDatabaseOpenFailure(databasePath, failure);

    const resumed = dispatchSuspensionRequest({
      method: "gateway.suspend.resume",
      scope: "operator.admin",
      handler: suspendHandlers["gateway.suspend.resume"]!,
      requestParams: { suspensionId: preparedPayload?.suspensionId },
      context,
    });
    await resumed.request;

    // Join the drain completion via its observed warning, then yield once.
    await vi.waitFor(() => {
      expect(cronLog.warn).toHaveBeenCalledWith(
        { err: String(failure) },
        "cron: queue drain delayed",
      );
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Gateway survived and stayed responsive under the fault.
    expect(unhandled).toEqual([]);
    const status = dispatchSuspensionRequest({
      method: "gateway.suspend.status",
      scope: "operator.admin",
      handler: suspendHandlers["gateway.suspend.status"]!,
      requestParams: { suspensionId: preparedPayload?.suspensionId },
      context,
    });
    await status.request;
    expect(status.respond).toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", observe);
    clearOpenClawStateDatabaseOpenFailure(databasePath);
    releaseBlockers();
    cron.stop();
    await Promise.allSettled([cron.waitForIdle()]);
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    void signal;
  }
});
