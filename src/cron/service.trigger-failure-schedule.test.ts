import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { CronEvent } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { waitForCronRunQueue } from "./service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "./service/scheduler-actor.test-support.js";
import type { CronAddOptions, CronServiceDeps } from "./service/state.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-trigger-failure-" });

const OWNER_SESSION = "agent:main:garry-watcher";

// The capture an authenticated Control UI turn stores through automations add.
const operatorSource = {
  version: 1,
  agentId: "main",
  sessionKey: OWNER_SESSION,
  sessionId: "owner-session",
  sourceRunId: "creator-run",
  snapshot: {
    profileId: "fixture-operator",
    scopes: ["operator.write"],
    assignedRole: null,
    githubLogin: null,
    grant: null,
    aliasBindingIds: [],
    authPolicy: {
      generation: "",
      grantGeneration: "fixture-generation",
      role: "operator",
      authMethod: "token",
    },
    controlUiAdmin: true,
    localOperator: false,
    sourceIngress: "control-ui",
  },
} satisfies NonNullable<CronAddOptions["operatorSource"]>;

const watcher: CronJobCreate = {
  name: "Garry Tan watcher",
  enabled: true,
  agentId: "main",
  schedule: { kind: "cron", expr: "0 */6 * * *", tz: "UTC", staggerMs: 0 },
  // Mirrors job e8941063: the script threw because a poll reported `running`.
  trigger: {
    script: 'throw new Error("gh search did not complete: running");',
  },
  sessionTarget: `session:${OWNER_SESSION}`,
  owner: { agentId: "main", sessionKey: OWNER_SESSION, accountId: "default" },
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Report new posts.", toolsAllow: ["*"] },
};

async function startWatcher(params: {
  withOperatorSource: boolean;
  /** Without a live Gateway occurrence, restoring the stored source is refused. */
  restoreOperatorSource: boolean;
}) {
  const store = await makeStorePath();
  const startMs = Date.parse("2026-11-18T07:51:00.000Z");
  const clock = createGatewaySchedulerClock(startMs);
  const finishedWaiters = new Map<string, () => void>();
  const runCronFailureRepair = vi.fn<NonNullable<CronServiceDeps["runCronFailureRepair"]>>(
    async () => {},
  );
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  // The production headless runtime; the job grants no tools, so the script throws at once.
  const scriptRuntime = createCronScriptRuntime({
    config: {},
    prepareRuntime: async ({ runtimeConfig }) => ({
      createTools: async () => [],
      context: { config: runtimeConfig, agentId: "main", sessionKey: "cron:watcher:trigger" },
      scheduledToolPolicy: undefined,
    }),
  });
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: () => clock.clock.now(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    cronConfig: { triggers: { enabled: true } },
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    // The scheduler keeps the stored source either way; the live-Gateway E2E covers its restore.
    evaluateCronTrigger: (evaluation) =>
      scriptRuntime.evaluateTrigger(
        params.restoreOperatorSource
          ? evaluation
          : { ...evaluation, job: { ...evaluation.job, operatorSource: undefined } },
      ),
    runCronFailureRepair,
    onEvent: (event: CronEvent) => {
      if (event.action === "finished") {
        finishedWaiters.get(event.jobId)?.();
      }
    },
  });
  const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
  const job = await cron.add(watcher, {
    ...(params.withOperatorSource ? { operatorSource } : {}),
    sourceConversation: { sessionKey: OWNER_SESSION, sessionId: operatorSource.sessionId },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: OWNER_SESSION,
      ownerAccountId: "default",
    },
  });
  expect(Boolean(job.operatorSource)).toBe(params.withOperatorSource);
  const fireNextOccurrence = async () => {
    const dueAtMs = cron.getJob(job.id)!.state.nextRunAtMs!;
    const run = new Promise<void>((resolve) => {
      finishedWaiters.set(job.id, resolve);
    });
    // The scheduler actor's own wake at the due time, as the host timer delivers it.
    clock.setTime(dueAtMs);
    await wake(state);
    await run;
    await waitForCronRunQueue(state);
    return dueAtMs;
  };
  return { cron, job, store, fireNextOccurrence, runCronFailureRepair, enqueueSessionEvent };
}

describe("a scheduled trigger script that throws", () => {
  it.each([true, false])(
    "keeps the job scheduled and tells the owner the next attempt (operatorSource: %s)",
    async (withOperatorSource) => {
      const h = await startWatcher({ withOperatorSource, restoreOperatorSource: false });
      try {
        const dueAtMs = await h.fireNextOccurrence();
        const job = h.cron.getJob(h.job.id)!;
        expect(job.state.lastRunStatus).toBe("error");
        expect(job.state.consecutiveErrors).toBe(1);
        expect(job.enabled).toBe(true);
        expect(job.state.autoDisabled).toBeUndefined();
        expect(job.state.nextRunAtMs).toBeGreaterThan(dueAtMs);
        expect(h.runCronFailureRepair).toHaveBeenCalledTimes(1);
        // The plain notice reached the user first; the repair brief carries it.
        expect(h.runCronFailureRepair.mock.calls[0]?.[0].message).toContain(
          "It is still on. Next attempt: ",
        );
      } finally {
        h.cron.stop();
        await h.store.cleanup();
      }
    },
  );

  it("turns the job off with a recorded reason and notice when its operator source is refused", async () => {
    const h = await startWatcher({ withOperatorSource: true, restoreOperatorSource: true });
    try {
      const dueAtMs = await h.fireNextOccurrence();
      const job = h.cron.getJob(h.job.id)!;
      expect(job.enabled).toBe(false);
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.state.autoDisabled).toMatchObject({ reason: "source-unavailable", atMs: dueAtMs });
      const notices = h.enqueueSessionEvent.mock.calls.map(([text]) => text);
      expect(notices).toEqual([expect.stringContaining("is turned off")]);
      expect(notices[0]).toContain("access of the person who created it was refused");
      expect(notices[0]).toContain('To resume it, reply "resume');
      expect(h.runCronFailureRepair).not.toHaveBeenCalled();
    } finally {
      h.cron.stop();
      await h.store.cleanup();
    }
  });
});
