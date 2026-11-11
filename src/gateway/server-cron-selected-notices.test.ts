import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronRunErrorReason } from "../cron/run-error-reason.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { recordScheduleComputeError } from "../cron/service/jobs-scheduling.js";
import { createCronServiceState, type DeferredCronNotifications } from "../cron/service/state.js";
import { runPostPersistCronNotifications } from "../cron/service/store.js";
import { applyJobResult } from "../cron/service/timer-outcomes.js";
import { saveCronStore } from "../cron/store.js";
import type { CronDelivery, CronStoredJob } from "../cron/types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

const runAt = 1_000_000;
const inboxKey = "agent:main:dashboard:notice-inbox";
const creatorKey = "agent:main:dashboard:notice-creator";

type Binding = "bound" | "reset" | "uncaptured";

// Real producers, notification dispatch, Gateway transport, and session persistence; only the
// in-app fallback queue is observed through its dependency.
async function withNoticeFixture(
  delivery: CronDelivery,
  failureAlert: CronStoredJob["failureAlert"],
  run: (fixture: {
    cfg: OpenClawConfig;
    job: CronStoredJob;
    produceThreshold: () => DeferredCronNotifications;
    produceScheduleErrors: () => DeferredCronNotifications;
    dispatch: (notifications: DeferredCronNotifications) => Promise<void>;
    messages: (sessionKey: string) => Promise<string[]>;
    enqueueSessionEvent: ReturnType<typeof vi.fn>;
    reset: () => Promise<unknown>;
  }) => Promise<void>,
  ownerAgentId = "main",
  cronConfig?: OpenClawConfig["cron"],
) {
  const fixtureInboxKey = `agent:${ownerAgentId}:dashboard:notice-inbox`;
  const fixtureCreatorKey = `agent:${ownerAgentId}:dashboard:notice-creator`;
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const storePath = path.join(state.sessionsDir(ownerAgentId), "sessions.json");
    const scope = (sessionKey: string) => ({ agentId: ownerAgentId, storePath, sessionKey });
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace: state.workspaceDir },
          [ownerAgentId]: { workspace: state.workspaceDir },
        },
      },
      session: { store: storePath },
    };
    const creator = { sessionId: "creator-session", lifecycleRevision: "creator-generation" };
    const inbox = { sessionId: "inbox-session", lifecycleRevision: "inbox-generation" };
    await replaceSessionEntry(scope(fixtureCreatorKey), { ...creator, updatedAt: 1 });
    await replaceSessionEntry(scope(fixtureInboxKey), { ...inbox, updatedAt: 1 });
    const transports: Promise<void>[] = [];
    const enqueueSessionEvent = vi.fn(async () => ({ ok: true as const }));
    const cronStorePath = state.statePath("cron", "jobs.json");
    const service = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => runAt + 10,
      storePath: cronStorePath,
      cronEnabled: true,
      log: createNoopLogger(),
      defaultAgentId: "main",
      cronConfig,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent,
      runIsolatedAgentJob: vi.fn(),
      sendCronFailureAlert: (params) => {
        const transport = sendGatewayCronFailureAlert({
          ...params,
          deps: {},
          logger: { warn: vi.fn() },
          resolveCronAgent: (requested) => ({ agentId: requested ?? "main", cfg }),
        });
        transports.push(transport);
        return transport;
      },
    });
    const job: CronStoredJob = {
      id: "notice-job",
      agentId: ownerAgentId,
      name: "notice job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: runAt },
      sessionTarget: "isolated",
      sessionKey: fixtureCreatorKey,
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery,
      ...(failureAlert === undefined ? {} : { failureAlert }),
      sourceConversation: { sessionKey: fixtureCreatorKey, ...creator },
      deliveryConversation: { sessionKey: fixtureInboxKey, ...inbox },
      state: { consecutiveErrors: 9, scheduleErrorCount: 2 },
    };
    await run({
      cfg,
      job,
      produceThreshold: () => {
        const deferredNotifications: DeferredCronNotifications = [];
        applyJobResult(
          service,
          job,
          {
            status: "error",
            error: "tenth failure",
            startedAt: runAt,
            endedAt: runAt + 10,
            errorReason: resolveCronRunErrorReason("tenth failure"),
          },
          { deferredNotifications },
        );
        return deferredNotifications;
      },
      produceScheduleErrors: () => {
        const deferredNotifications: DeferredCronNotifications = [];
        recordScheduleComputeError({
          state: service,
          job,
          err: new Error("bad schedule"),
          deferredNotifications,
        });
        return deferredNotifications;
      },
      dispatch: async (notifications) => {
        // The scheduler persists the outcome before it dispatches its notifications.
        await saveCronStore(cronStorePath, { version: 1, jobs: [job] });
        await runPostPersistCronNotifications(service, structuredClone(notifications));
        // Dispatch detaches Gateway transports. Await their actual completion instead of
        // racing the default polling deadline against cold session-store workers. Expected
        // stale-target rejections settle their in-app fallback before rejecting.
        await Promise.allSettled(transports);
        expect(transports.length + enqueueSessionEvent.mock.calls.length).toBeGreaterThan(0);
      },
      messages: async (sessionKey) => {
        const entry = loadSessionEntryReadOnly({
          ...scope(sessionKey),
          readConsistency: "latest",
        });
        if (!entry) {
          return [];
        }
        return (await loadTranscriptEvents({ ...scope(sessionKey), sessionId: entry.sessionId }))
          .map(readTranscriptEventMessage)
          .filter((message) => message?.role === "assistant")
          .map((message) => JSON.stringify(message?.content));
      },
      enqueueSessionEvent,
      reset: () =>
        resetSessionEntryLifecycle({
          storePath,
          target: { canonicalKey: fixtureInboxKey, storeKeys: [fixtureInboxKey] },
          buildNextEntry: () => ({
            sessionId: "inbox-replacement",
            lifecycleRevision: "inbox-replacement-generation",
            updatedAt: 2,
          }),
        }),
    });
  });
}

describe.each([
  {
    name: "announce with alerts off",
    delivery: { mode: "announce", sessionKey: inboxKey },
    failureAlert: false,
  },
  {
    name: "silent delivery",
    delivery: { mode: "none", sessionKey: inboxKey },
    failureAlert: undefined,
  },
] satisfies Array<{
  name: string;
  delivery: CronDelivery;
  failureAlert: CronStoredJob["failureAlert"];
}>)("auto-disable safety notice for $name", ({ delivery, failureAlert }) => {
  it.each([
    ["threshold", "run failures"],
    ["schedule", "schedule errors"],
  ] as const)("commits the %s notice to the selected conversation", async (producer, words) =>
    withNoticeFixture(delivery, failureAlert, async (fixture) => {
      const notifications =
        producer === "threshold" ? fixture.produceThreshold() : fixture.produceScheduleErrors();
      expect(fixture.job.state.autoDisabled).toBeDefined();
      expect(notifications.map(({ kind }) => kind)).toEqual(["auto-disabled"]);
      await fixture.dispatch(notifications);

      expect(await fixture.messages(inboxKey)).toEqual([expect.stringContaining(words)]);
      expect(await fixture.messages(creatorKey)).toEqual([]);
      expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
    }),
  );

  it.each(["reset", "uncaptured"] as const satisfies readonly Binding[])(
    "records a %s destination and tells the owning agent instead of the creator",
    async (binding) =>
      withNoticeFixture(delivery, failureAlert, async (fixture) => {
        if (binding === "reset") {
          await fixture.reset();
        } else {
          delete fixture.job.deliveryConversation;
        }
        await fixture.dispatch(fixture.produceThreshold());

        expect(await fixture.messages(inboxKey)).toEqual([]);
        expect(await fixture.messages(creatorKey)).toEqual([]);
        expect(fixture.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("run failures"),
          expect.objectContaining({ agentId: "main", contextKey: "cron:notice-job:auto-disabled" }),
        );
        expect(fixture.enqueueSessionEvent.mock.calls[0]?.[1]).toMatchObject({
          sessionKey: undefined,
          createIfMissing: true,
        });
      }),
  );
});

it("sends an explicit failure alert from a silent job only to the selected conversation", () =>
  withNoticeFixture(
    { mode: "none", sessionKey: inboxKey },
    { after: 1, cooldownMs: 0 },
    async (fixture) => {
      fixture.job.state.consecutiveErrors = 0;
      const notifications = fixture.produceThreshold();
      expect(notifications.map(({ kind }) => kind)).toEqual(["failure-alert"]);
      await fixture.dispatch(notifications);

      expect(await fixture.messages(inboxKey)).toEqual([expect.stringContaining("failed")]);
      expect(await fixture.messages(creatorKey)).toEqual([]);
      expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
    },
  ));

it("keeps primary-route alerts in the selected conversation over a default destination", () =>
  withNoticeFixture(
    { mode: "announce", sessionKey: inboxKey },
    { after: 1, cooldownMs: 0 },
    async (fixture) => {
      fixture.job.state.consecutiveErrors = 0;
      await fixture.dispatch(fixture.produceThreshold());

      expect(await fixture.messages(inboxKey)).toEqual([expect.stringContaining("failed")]);
      expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
    },
    "main",
    { delivery: { channel: "telegram", to: "123" } },
  ));

it("keeps a silent job's busy skip quiet without muting its explicit alert or safety notice", () =>
  withNoticeFixture(
    { mode: "none", sessionKey: inboxKey },
    { after: 1, cooldownMs: 0 },
    async (fixture) => {
      dispatchGatewayCronFinishedNotifications({
        evt: {
          jobId: fixture.job.id,
          action: "finished",
          status: "skipped",
          runAtMs: runAt,
          summary: "Automation deferred while its agent is busy",
        },
        job: fixture.job,
        runNotStarted: true,
        resolveCronAgent: () => ({ agentId: "main", cfg: fixture.cfg }),
        logger: { warn: vi.fn() },
      });
      // A run-outcome notice is detached root work; wait until it has settled.
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(await fixture.messages(creatorKey)).toEqual([]);
      expect(await fixture.messages(inboxKey)).toEqual([]);

      fixture.job.state.consecutiveErrors = 0;
      const notifications = [...fixture.produceThreshold(), ...fixture.produceScheduleErrors()];
      expect(notifications.map(({ kind }) => kind)).toEqual(["failure-alert", "auto-disabled"]);
      await fixture.dispatch(notifications);
      expect(await fixture.messages(inboxKey)).toEqual([
        expect.stringContaining("failed"),
        expect.stringContaining("schedule errors"),
      ]);
      expect(await fixture.messages(creatorKey)).toEqual([]);
    },
  ));

it("keeps a silent job quiet when only the destination is selected", () =>
  withNoticeFixture({ mode: "none", sessionKey: inboxKey }, undefined, async (fixture) => {
    fixture.job.state.consecutiveErrors = 0;
    expect(fixture.produceThreshold()).toEqual([]);
  }));

it.each(["reset", "uncaptured"] as const satisfies readonly Binding[])(
  "records an explicit alert for a %s destination and tells the owning agent",
  (binding) =>
    withNoticeFixture(
      { mode: "none", sessionKey: inboxKey },
      { after: 1, cooldownMs: 0 },
      async (fixture) => {
        if (binding === "reset") {
          await fixture.reset();
        } else {
          delete fixture.job.deliveryConversation;
        }
        fixture.job.state.consecutiveErrors = 0;
        await fixture.dispatch(fixture.produceThreshold());

        await vi.waitFor(() => expect(fixture.enqueueSessionEvent).toHaveBeenCalledOnce());
        expect(fixture.enqueueSessionEvent.mock.calls[0]?.[1]).toMatchObject({
          agentId: "main",
          contextKey: "cron:notice-job:failure-alert",
        });
        expect(fixture.enqueueSessionEvent.mock.calls[0]?.[1]).toMatchObject({
          sessionKey: undefined,
          createIfMissing: true,
        });
        expect(await fixture.messages(inboxKey)).toEqual([]);
        expect(await fixture.messages(creatorKey)).toEqual([]);
      },
    ),
);

it.each([
  { mode: "none", route: "failureDestination" },
  { mode: "none", route: "failureAlert" },
  { mode: "announce", route: "failureDestination" },
  { mode: "announce", route: "failureAlert" },
] as const)(
  "does not replace an explicit $route last route for $mode with the selected conversation",
  ({ mode, route }) =>
    withNoticeFixture(
      {
        mode,
        sessionKey: inboxKey,
        ...(route === "failureDestination" ? { failureDestination: { channel: "last" } } : {}),
      },
      { after: 1, cooldownMs: 0, ...(route === "failureAlert" ? { channel: "last" } : {}) },
      async (fixture) => {
        fixture.job.state.consecutiveErrors = 0;
        const notifications = fixture.produceThreshold();
        expect(notifications).toEqual([
          expect.objectContaining({
            kind: "failure-alert",
            route: expect.objectContaining({ channel: "last", alternateRoute: true }),
          }),
        ]);
        await fixture.dispatch(notifications);

        // The explicit last route has no remembered external channel in this fixture.
        // It must fail into the documented in-app fallback, not silently use the inbox.
        expect(await fixture.messages(inboxKey)).toEqual([]);
        expect(await fixture.messages(creatorKey)).toEqual([]);
        expect(fixture.enqueueSessionEvent).toHaveBeenCalledOnce();
      },
    ),
);

it.each(["bound", "reset", "uncaptured"] as const satisfies readonly Binding[])(
  "preserves the source agent of an agent-less job for a %s selected safety notice",
  (binding) => {
    const workerInboxKey = "agent:worker:dashboard:notice-inbox";
    const workerCreatorKey = "agent:worker:dashboard:notice-creator";
    return withNoticeFixture(
      { mode: "none", sessionKey: workerInboxKey },
      false,
      async (fixture) => {
        delete fixture.job.agentId;
        if (binding === "reset") {
          await fixture.reset();
        } else if (binding === "uncaptured") {
          delete fixture.job.deliveryConversation;
        }
        await fixture.dispatch(fixture.produceThreshold());

        expect(await fixture.messages(workerCreatorKey)).toEqual([]);
        if (binding === "bound") {
          expect(await fixture.messages(workerInboxKey)).toEqual([
            expect.stringContaining("run failures"),
          ]);
          expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
        } else {
          expect(await fixture.messages(workerInboxKey)).toEqual([]);
          expect(fixture.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining("run failures"),
            expect.objectContaining({
              agentId: "worker",
              sessionKey: undefined,
              createIfMissing: true,
              contextKey: "cron:notice-job:auto-disabled",
            }),
          );
        }
      },
      "worker",
    );
  },
);
