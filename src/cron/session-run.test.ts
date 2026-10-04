import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SessionEventOutcome } from "../auto-reply/reply/session-event-contract.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueAutomationSystemEvent,
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resolveAdmittedCronCompletionStatus } from "./completion-status.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { createCronServiceState, type CronServiceDeps } from "./service/state.js";
import { executeJobCore } from "./service/timer-execution.js";
import { runCronSessionTurn } from "./session-run.js";

const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(),
  delivery: vi.fn(),
  scratch: vi.fn(),
  config: {},
}));
// mock-isolation: Control admission and settlement receipts without dispatching real session or model turns.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: (_agent: string, sessionKey: string) => ({
    sessionId: "session",
    sessionKey,
    generation: "generation",
    deliveryContext: { channel: "telegram", to: "old-group" },
  }),
  enqueueSessionEventForHost: fixture.enqueue,
}));
// mock-isolation: Recheck the fixture config instead of process-wide config IO and runtime snapshots.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
// mock-isolation: Control route-policy transitions without resolving the channel and plugin delivery runtime.
vi.mock("./isolated-agent/run-delivery-trace.js", () => ({
  resolveCronDeliveryContext: fixture.delivery,
  buildCronDeliveryTrace: (input: unknown) => input,
}));
// mock-isolation: Exercise scratch gating with fixture snapshots without entering shared-state database workers.
vi.mock("./scratch-read.js", () => ({ readCronScratchSnapshot: fixture.scratch }));
// mock-isolation: Keep the synthetic /unused cron store detached from SQLite and store-mutation observers.
vi.mock("./store.js", () => ({ resolveCronJobsStorePathFromConfig: () => "/unused" }));
// mock-isolation: Exercise session execution without invoking receipt-backed global plugin prompt hooks.
vi.mock("../infra/heartbeat-compat.js", () => ({
  applyLegacyHeartbeatPromptContribution: ({ prompt }: { prompt: string }) => prompt,
}));

beforeEach(() => {
  resetSystemEventsForTest();
  publishSystemEventStoreResolver(undefined);
  fixture.enqueue.mockReset().mockReturnValue({
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  });
  fixture.delivery.mockReset();
  fixture.scratch.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetSystemEventsForTest();
  publishSystemEventStoreResolver(undefined);
});

const params = () => ({
  admissionSource: "operator-schedule" as const,
  cfg: fixture.config,
  agentId: "main",
  sessionKey: "agent:main:main",
  text: "check",
  assertCurrent: vi.fn(),
  deliveryAttemptFence: null,
  job: makeCronJob({
    sessionTarget: "session:agent:main:main",
    delivery: { mode: "announce", target: "owner" },
  }),
});

describe("scheduled session execution", () => {
  it("skips before session execution when owner delivery has no route", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: true,
      deliveryPlan: { mode: "announce", target: "owner" },
      resolvedDelivery: {
        ok: false,
        error: new Error("Owner delivery unavailable (no-route); configure an authorized owner DM"),
      },
    });
    const result = await runCronSessionTurn(params());
    expect(result).toMatchObject({
      status: "skipped",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
      summary: expect.stringContaining("configure an authorized owner DM"),
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("records a denied DM as intentional non-delivery without borrowing the old route", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: true,
      deliveryPlan: { mode: "announce" },
      resolvedDelivery: {
        ok: false,
        error: new Error("direct policy blocks DM"),
        deliverySuppressionReason: "channel_transform",
      },
    });
    const result = await runCronSessionTurn(params());
    expect(result).toMatchObject({
      status: "ok",
      delivered: false,
      deliverySuppressionReason: "channel_transform",
    });
    expect(result.deliveryError).toBeUndefined();
    expect(fixture.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliver: false, deliveryContext: undefined }),
    );
  });

  it("rechecks current delivery policy before the adapter handoff", async () => {
    fixture.delivery
      .mockResolvedValueOnce({
        deliveryRequested: true,
        deliveryPlan: { mode: "announce" },
        resolvedDelivery: {
          ok: true,
          channel: "telegram",
          to: "owner",
          accountId: "work",
          threadId: "7",
        },
      })
      .mockResolvedValueOnce({
        deliveryRequested: false,
        deliveryPlan: { mode: "none" },
        resolvedDelivery: { ok: false },
      });
    await runCronSessionTurn(params());
    const options = fixture.enqueue.mock.calls[0]![1];
    expect(options.deliveryContext).toMatchObject({
      to: "owner",
      accountId: "work",
      threadId: "7",
    });
    await expect(options.scheduledAutomation.beforeDeliver()).rejects.toThrow(
      "policy or owner route changed",
    );
  });

  it("reports the ordinary reply invocation to the cron timeout owner", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: false,
      deliveryPlan: { mode: "none" },
      resolvedDelivery: { ok: false },
    });
    fixture.enqueue.mockImplementation((_text, request) => {
      request.scheduledAutomation.onStarted();
      request.scheduledAutomation.onExecutionStarted({
        runId: "shared-cron-invocation",
        sessionId: "session",
        sessionKey: "agent:main:main",
      });
      return {
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      };
    });
    const onExecutionStarted = vi.fn();
    await runCronSessionTurn({ ...params(), onExecutionStarted });
    expect(onExecutionStarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        jobId: "job-1",
        sessionId: "session",
        sessionKey: "agent:main:main",
        runId: "shared-cron-invocation",
      }),
    );
  });

  it("does not mark required delivery complete after an identityless send", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: true,
      deliveryPlan: { mode: "announce" },
      resolvedDelivery: { ok: true, channel: "telegram", to: "owner" },
    });
    fixture.enqueue.mockReturnValue({
      settled: Promise.resolve({
        status: "completed",
        executionStarted: true,
        delivered: true,
        deliveryAttempted: true,
        deliveryAmbiguous: true,
      }),
    });
    const input = params();
    const result = await runCronSessionTurn(input);
    expect(result.delivered).toBeUndefined();
    expect(result).toMatchObject({
      status: "ok",
      deliveryAttempted: true,
      deliveryState: { status: "unknown" },
    });
    expect(
      resolveAdmittedCronCompletionStatus(input.job, result.status, result.deliveryState!.status),
    ).toBe("unknown");
  });
});

const executionSessionKey = "agent:ops:scheduled-work";
const authoringSessionKey = "agent:ops:authoring-conversation";

function enqueueNotice(text: string, jobId: string, sessionKey = executionSessionKey) {
  const lease = { assertCurrent: vi.fn(), release: vi.fn() };
  const owner = { jobId, assertCurrent: vi.fn(), prepare: vi.fn(async () => lease) };
  enqueueAutomationSystemEvent(text, { sessionKey }, owner);
  return { owner, lease };
}

function createScheduledRun(
  options: {
    noOwnerRoute?: boolean;
    emptyScratch?: boolean;
    evaluateCronTrigger?: CronServiceDeps["evaluateCronTrigger"];
  } = {},
) {
  fixture.delivery.mockResolvedValue(
    options.noOwnerRoute
      ? {
          deliveryRequested: true,
          deliveryPlan: { mode: "announce", target: "owner" },
          resolvedDelivery: {
            ok: false,
            error: new Error(
              "Owner delivery unavailable (no-route); configure an authorized owner DM",
            ),
          },
        }
      : {
          deliveryRequested: false,
          deliveryPlan: { mode: "none" },
          resolvedDelivery: { ok: false },
        },
  );
  fixture.scratch.mockResolvedValue({
    jobId: "job-1",
    state: {
      currentRevision: 1,
      scratch: {
        content: options.emptyScratch ? "# Checklist\n" : "Check the inbox",
        revision: 1,
        updatedAtMs: 1,
      },
    },
  });
  const job = makeCronJob({
    sessionTarget: "main",
    sessionKey: authoringSessionKey,
    payload: {
      kind: "agentTurn",
      message: "check",
      skipIfScratchEmpty: Boolean(options.emptyScratch),
    },
    ...(options.evaluateCronTrigger ? { trigger: { script: "return false" } } : {}),
    delivery: options.noOwnerRoute ? { mode: "announce", target: "owner" } : { mode: "none" },
  });
  let sessionKey = executionSessionKey;
  const resolveSessionEventTarget = vi.fn(() => ({ agentId: "ops", sessionKey }));
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    storePath: "/unused",
    defaultAgentId: "ops",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    resolveSessionEventTarget,
    runSessionEvent: (request) =>
      runCronSessionTurn({
        ...request,
        cfg: fixture.config,
        ...resolveSessionEventTarget(),
      }),
    runIsolatedAgentJob: vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async () => ({
      status: "ok",
    })),
    evaluateCronTrigger: options.evaluateCronTrigger,
  });
  return {
    job,
    run: () => executeJobCore(state, job),
    resolveSessionEventTarget,
    retarget: () => {
      sessionKey = "agent:ops:replacement-session";
    },
  };
}

describe("deferred automation notices through scheduled session execution", () => {
  it.each([
    { name: "an unavailable owner route", noOwnerRoute: true },
    { name: "explicitly empty scratch", emptyScratch: true },
    {
      name: "an unavailable owner route and explicitly empty scratch",
      noOwnerRoute: true,
      emptyScratch: true,
    },
  ])(
    "executes attached notices despite $name and consumes only the admitted selection",
    async (options) => {
      const scheduled = createScheduledRun(options);
      const unrelated = enqueueNotice("Another automation's notice", "other-job");
      const authoring = enqueueNotice(
        "Authoring conversation notice",
        scheduled.job.id,
        authoringSessionKey,
      );
      enqueueSystemEvent("Ordinary session notice", { sessionKey: executionSessionKey });
      const unrelatedEntries = peekSystemEventEntries(executionSessionKey);
      await expect(scheduled.run()).resolves.toMatchObject({
        status: "skipped",
        executionStarted: false,
      });
      expect(fixture.enqueue).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(executionSessionKey)).toEqual(unrelatedEntries);
      fixture.scratch.mockClear();
      const selected = enqueueNotice("Selected scheduled notice", scheduled.job.id);
      const original = peekSystemEventEntries(executionSessionKey);
      const selectedId = original.at(-1)!.id;
      const entered = createDeferred();
      const terminal = createDeferred<SessionEventOutcome>();
      fixture.enqueue.mockImplementation(() => {
        entered.resolve();
        return { settled: terminal.promise };
      });
      const running = scheduled.run();
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "enqueued"),
            running.then(() => "finished"),
          ]),
        ).toBe("enqueued");
        expect(scheduled.resolveSessionEventTarget).toHaveBeenNthCalledWith(1, {
          agentId: undefined,
          sessionKey: undefined,
        });
        const [text, request] = fixture.enqueue.mock.calls[0]!;
        expect(request).toMatchObject({ agentId: "ops", sessionKey: executionSessionKey });
        expect(text).toContain("Selected scheduled notice");
        expect(text).not.toContain("Another automation's notice");
        expect(text).not.toContain("Ordinary session notice");
        expect(text).not.toContain("Authoring conversation notice");
        if (options.noOwnerRoute) {
          expect(request).toMatchObject({ deliver: false, deliveryContext: undefined });
        }
        expect(peekSystemEventEntries(executionSessionKey)).toEqual(original);
        expect(selected.owner.prepare).toHaveBeenCalledOnce();
        expect(selected.lease.release).not.toHaveBeenCalled();
        expect(fixture.scratch).toHaveBeenCalledOnce();
        const later = enqueueNotice("Later scheduled notice", scheduled.job.id);
        const pendingBeforeStart = peekSystemEventEntries(executionSessionKey);
        request.scheduledAutomation.onStarted();
        expect(peekSystemEventEntries(executionSessionKey)).toEqual(
          pendingBeforeStart.filter((event) => event.id !== selectedId),
        );
        expect(peekSystemEventEntries(authoringSessionKey).map((event) => event.text)).toEqual([
          "Authoring conversation notice",
        ]);
        terminal.resolve({ status: "completed", executionStarted: true, delivered: false });
        await expect(running).resolves.toMatchObject({ status: "ok", executionStarted: true });
        expect(selected.lease.release).toHaveBeenCalledOnce();
        for (const remaining of [unrelated, authoring, later]) {
          expect(remaining.owner.prepare).not.toHaveBeenCalled();
          expect(remaining.lease.release).not.toHaveBeenCalled();
        }
      } finally {
        terminal.resolve({ status: "cancelled", executionStarted: false, delivered: false });
        await running;
      }
    },
  );

  it("preserves attached notices and releases their custody when the trigger rejects the occurrence", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: false }));
    const scheduled = createScheduledRun({ emptyScratch: true, evaluateCronTrigger });
    const selected = enqueueNotice("Retry on the next matching occurrence", scheduled.job.id);
    const original = peekSystemEventEntries(executionSessionKey);
    await expect(scheduled.run()).resolves.toMatchObject({ triggerEval: { fired: false } });
    expect(evaluateCronTrigger).toHaveBeenCalledOnce();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(executionSessionKey)).toEqual(original);
    expect(selected.owner.prepare).toHaveBeenCalledOnce();
    expect(selected.lease.release).toHaveBeenCalledOnce();
  });

  it("rejects a notice cancelled during scratch lookup before it can authorize trigger effects", async () => {
    const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
    const scheduled = createScheduledRun({ emptyScratch: true, evaluateCronTrigger });
    const selected = enqueueNotice("Cancelled scheduled notice", scheduled.job.id);
    const selectedEntries = peekSystemEventEntries(executionSessionKey);
    enqueueNotice("Unrelated automation notice", "other-job");
    const unrelated = peekSystemEventEntries(executionSessionKey).slice(1);
    fixture.scratch.mockImplementationOnce(async () => {
      consumeSelectedSystemEventEntries(executionSessionKey, selectedEntries);
      return {
        jobId: scheduled.job.id,
        state: {
          currentRevision: 1,
          scratch: { content: "# Checklist\n", revision: 1, updatedAtMs: 1 },
        },
      };
    });

    await expect(scheduled.run()).rejects.toThrow(
      "Deferred automation notice was cancelled before execution",
    );
    expect(evaluateCronTrigger).not.toHaveBeenCalled();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(executionSessionKey)).toEqual(unrelated);
    expect(selected.owner.prepare).toHaveBeenCalledOnce();
    expect(selected.lease.release).toHaveBeenCalledOnce();
  });

  it("preserves attached notices and releases their custody when ordinary admission defers", async () => {
    const scheduled = createScheduledRun({ noOwnerRoute: true, emptyScratch: true });
    const selected = enqueueNotice("Retry when the session admits work", scheduled.job.id);
    const original = peekSystemEventEntries(executionSessionKey);
    fixture.enqueue.mockReturnValue({
      settled: Promise.resolve({
        status: "completed",
        admissionDeferred: true,
        executionStarted: false,
        delivered: false,
      }),
    });
    await expect(scheduled.run()).resolves.toMatchObject({
      status: "skipped",
      admissionDeferred: true,
    });
    expect(fixture.enqueue).toHaveBeenCalledOnce();
    expect(peekSystemEventEntries(executionSessionKey)).toEqual(original);
    expect(selected.owner.prepare).toHaveBeenCalledOnce();
    expect(selected.lease.release).toHaveBeenCalledOnce();
  });

  it("refuses a changed execution target and releases the original notice preparation", async () => {
    const scheduled = createScheduledRun();
    const selected = enqueueNotice("Keep this notice with its original session", scheduled.job.id);
    selected.owner.prepare.mockImplementationOnce(async () => {
      scheduled.retarget();
      return selected.lease;
    });
    const original = peekSystemEventEntries(executionSessionKey);
    await expect(scheduled.run()).rejects.toThrow(
      "Automation session target changed after notice preparation",
    );
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(peekSystemEventEntries(executionSessionKey)).toEqual(original);
    expect(selected.lease.release).toHaveBeenCalledOnce();
  });
});
