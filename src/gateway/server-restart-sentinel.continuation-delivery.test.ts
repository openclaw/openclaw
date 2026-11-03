// Restart recovery of queued continuation deliveries: recipient authority and
// continuation return ownership.
// Register the shared module mocks before any module they replace is imported.
import "./server-restart-sentinel.mocks.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  captureSessionRecipientAuthority,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { configureRestartSessionEventMocks } from "./server-restart-sentinel.test-support.js";
import * as restartUpdateRun from "./server-restart-update-run.js";

const { mocks } = await import("./server-restart-sentinel.mocks.test-harness.js");

vi.resetModules();

const { deliverQueuedSessionDelivery } = await import("./server-restart-sentinel.js");
const { resetGatewayWorkAdmission } = await import("../process/gateway-work-admission.js");
const actualRestartUpdateRun = await vi.importActual<
  typeof import("./server-restart-update-run.js")
>("./server-restart-update-run.js");
const { isSessionRecipientAuthorityCurrentInWorker: isActualSessionRecipientAuthorityCurrent } =
  await vi.importActual<typeof import("../config/sessions/session-recipient-authority-current.js")>(
    "../config/sessions/session-recipient-authority-current.js",
  );

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let testState: OpenClawTestState;

describe("restart recovery of queued continuation deliveries", () => {
  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    await scheduler.stop();
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    await testState.cleanup();
  });

  beforeEach(async () => {
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
    vi.mocked(restartUpdateRun.finalizeRestartUpdateRun)
      .mockReset()
      .mockImplementation(actualRestartUpdateRun.finalizeRestartUpdateRun);
    testState = await createOpenClawTestState({
      label: "gateway-restart-sentinel",
      layout: "state-only",
    });
    // #169714: real session-store writes resolve their path from the published snapshot,
    // which applying the test state's env clears.
    setRuntimeConfigSnapshot({});
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    mocks.queuedSessionDelivery = null;
    mocks.setInitialOutboundDelivery(null);
    mocks.dispatchGatewayMethodInProcess.mockReset();
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });
    mocks.readRestartSentinel.mockReset();
    mocks.readRestartSentinel.mockResolvedValue({
      version: 1,
      revision: 123,
      payload: {
        kind: "restart",
        status: "ok",
        ts: 123,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      },
    });
    mocks.parseSessionThreadInfo.mockReset();
    mocks.parseSessionThreadInfo.mockReturnValue({ baseSessionKey: null, threadId: undefined });
    mocks.loadSessionEntry.mockReset();
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: { commands: { ownerAllowFrom: ["+15550002"] } },
      agentId: "main",
      entry: { sessionId: sessionKey, updatedAt: 0 },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    }));
    // Worker session reads and plain-notice session events (#167113) read these rows.
    configureRestartSessionEventMocks(mocks as never);
    // Upstream's sentinel reads the command owner from the runtime config, not the row.
    vi.mocked(getRuntimeConfig).mockReturnValue({
      commands: { ownerAllowFrom: ["+15550002"] },
    } as never);
    mocks.isSessionRecipientAuthorityCurrent.mockReset().mockReturnValue(true);
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.getChannelPlugin.mockReset();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.normalizeChannelId.mockClear();
    mocks.resolveOutboundTarget.mockReset();
    mocks.resolveOutboundTarget.mockReturnValue({ ok: true as const, to: "+15550002" });
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]);
    mocks.enqueueDeliveryOnce.mockReset();
    mocks.enqueueDeliveryOnce.mockImplementation(async (_payload, id) => ({ id, created: true }));
    mocks.findDeliveryIntentOwner.mockReset();
    mocks.findDeliveryIntentOwner.mockResolvedValue(null);
    mocks.withStableDeliveryPreparation.mockReset();
    mocks.withStableDeliveryPreparation.mockImplementation(
      async (params: {
        id: string;
        run: (owner: {
          current: () => Promise<Record<string, unknown>>;
          beforeFirstModifier: () => Promise<void>;
          markPrepared: () => Promise<void>;
          markPublished: () => void;
        }) => Promise<unknown>;
      }) => ({
        status: "claimed",
        value: await params.run({
          current: async () => ({ id: params.id }),
          beforeFirstModifier: async () => {},
          markPrepared: async () => {},
          markPublished: () => {},
        }),
      }),
    );
    mocks.ackDelivery.mockClear();
    mocks.failDelivery.mockClear();
    mocks.failDeliveryAfterPlatformSend.mockClear();
    mocks.failDeliveryBeforePlatformSend.mockClear();
    mocks.failPendingDelivery.mockClear();
    mocks.loadPendingDelivery.mockReset();
    mocks.loadPendingDelivery.mockResolvedValue(null);
    mocks.drainPendingDeliveries.mockClear();
    mocks.reserveDeliveryAttempt.mockClear();
    mocks.withActiveDeliveryClaim.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.requestContinuationWake.mockClear();
    mocks.enqueueSessionDelivery.mockClear();
    mocks.deferSessionDelivery.mockClear();
    mocks.failSessionDelivery.mockClear();
    mocks.mergeSessionDeliveryPreparedMediaBlocks.mockClear();
    mocks.markSessionDeliveryAttemptStarted.mockClear();
    mocks.markSessionDeliverySettlement.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockReset();
    mocks.createManagedOutgoingMediaBlocks.mockReset();
    mocks.attachManagedOutgoingMediaToMessage.mockReset();
    mocks.enrichAssistantTranscriptMediaForRun.mockReset();
    mocks.removeCronRunContinuationSessionIfIdle.mockClear();
    mocks.settleCorrelatedSubagentDelivery.mockClear();
    mocks.loadPendingSessionDelivery.mockClear();
    mocks.drainPendingSessionDelivery.mockClear();
    mocks.recoverPendingSessionDeliveries.mockClear();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockResolvedValue(null);
    mocks.clearSentinel.mockReset();
    mocks.clearSentinel.mockResolvedValue(true);
    mocks.formatRestartSentinelMessage.mockClear();
    mocks.summarizeRestartSentinel.mockClear();
    mocks.resolveSystemMainSessionTarget.mockReset();
    mocks.resolveSystemMainSessionTarget.mockReturnValue({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    mocks.recordInboundSessionAndDispatchReply.mockReset();
    mocks.recordInboundSessionAndDispatchReply.mockResolvedValue(undefined);
    mocks.logInfo.mockClear();
    mocks.logWarn.mockClear();
    mocks.logError.mockClear();
  });

  it("routes post-compaction queue recovery before generic writable session loading", async () => {
    mocks.loadSessionEntry.mockImplementation(() => {
      throw new Error("generic session store must not be loaded");
    });

    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "post-compaction-disabled-before-generic-load",
          kind: "postCompactionDelegate",
          sessionKey: "agent:main:main",
          task: "remain pending while continuation is disabled",
          // Every entry this build enqueues carries its launch key (RFC §5.4.4
          // Q2); a keyless entry would end on the no-attempt-key rule instead.
          childRunId: "continuation:post-compaction-disabled-record:1",
          // Freshly armed: an entry stamped at epoch 1 would terminalize on the
          // RFC §4.4 stale gate instead of reaching the disabled deferral.
          createdAt: Date.now(),
          firstArmedAt: Date.now(),
          enqueuedAt: Date.now(),
          retryCount: 0,
        },
      }),
    ).rejects.toThrow("continuation is disabled");
    expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("replays a bound logical recipient after a session id rollover", async () => {
    const recipientAuthority = await captureSessionRecipientAuthority({
      agentId: "main",
      env: testState.env,
      sessionKey: "agent:main:main",
    });
    mocks.isSessionRecipientAuthorityCurrent.mockReturnValue(true);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "main",
      entry: {
        sessionId: "new-session-incarnation",
        updatedAt: 2,
      },
      store: {},
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
      legacyKey: undefined,
    });

    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        stateDir: testState.stateDir,
        entry: {
          id: "delivery-authority-rollover",
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "accepted delegate result",
          enqueuedAt: 1,
          retryCount: 0,
          recipientAuthority,
          awaitPromptAdoption: true,
        },
      }),
    ).rejects.toThrow("system event is awaiting durable prompt adoption");

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("accepted delegate result", {
      sessionKey: "agent:main:main",
      contextKey: "task:restart-sentinel:delivery-authority-rollover",
      sessionDeliveryAckId: "delivery-authority-rollover",
      sessionDeliveryAckStateDir: testState.stateDir,
      sessionDeliveryAwaitsTurnAdoption: true,
      recipientAuthority,
      trusted: true,
    });
    expect(mocks.requestContinuationWake).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      // The wake is agent-qualified: continuation ownership travels with the
      // wake so a replayed recipient cannot wake another agent's session.
      agentId: "main",
      reason: "restart-sentinel",
      deliveryIds: ["delivery-authority-rollover"],
    });
  });

  it.each(["owner reassignment", "member access removal", "explicit revocation"] as const)(
    "rejects a stale recipient after %s before prompt eligibility or wake",
    async (invalidation) => {
      const invalidationSlug = invalidation.replaceAll(" ", "-");
      const sessionKey = `agent:main:revoked-${invalidationSlug}`;
      const ownerA = { type: "human" as const, id: "owner-a", source: "unknown" as const };
      const authorityScope = {
        agentId: "main",
        env: testState.env,
        sessionKey,
      };
      await upsertSessionEntryCore(authorityScope, {
        sessionId: "recipient-before-revocation",
        updatedAt: 1,
        createdActor: ownerA,
      });
      const storePath = openOpenClawAgentDatabase({
        agentId: "main",
        env: testState.env,
      }).path;
      if (invalidation === "member access removal") {
        expect(
          (
            await addSessionMember(authorityScope, {
              identityId: "member-a",
              addedBy: ownerA.id,
              addedAt: 2,
            })
          ).inserted,
        ).toBe(true);
      }
      const recipientAuthority = await captureSessionRecipientAuthority(authorityScope);

      if (invalidation === "owner reassignment") {
        expect(
          assignSessionOwner(authorityScope, {
            owner: { type: "human", id: "owner-b" },
            assignedBy: ownerA,
            assignedAt: 3,
          }),
        ).not.toBeNull();
      } else if (invalidation === "member access removal") {
        expect(await removeSessionMember(authorityScope, "member-a")).not.toBeNull();
      } else {
        const deletion = await deleteSessionEntryLifecycle({
          agentId: "main",
          archiveTranscript: false,
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
        expect(deletion.deleted).toBe(true);
      }

      expect(
        await isActualSessionRecipientAuthorityCurrent(authorityScope, recipientAuthority),
      ).toBe(false);
      mocks.isSessionRecipientAuthorityCurrent.mockImplementation((scope, authority) =>
        isActualSessionRecipientAuthorityCurrent(scope, authority),
      );
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        agentId: "main",
        entry: {
          sessionId: "replacement-session",
          updatedAt: 4,
        },
        store: {},
        storePath,
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
        legacyKey: undefined,
      });

      // Refused: dead-lettered with its reason, so recovery never settles it as recovered.
      await expect(
        deliverQueuedSessionDelivery({
          deps: {} as never,
          stateDir: testState.stateDir,
          entry: {
            id: `delivery-stale-${invalidationSlug}`,
            kind: "systemEvent",
            sessionKey,
            text: "stale delegate result",
            enqueuedAt: 1,
            retryCount: 0,
            recipientAuthority,
            awaitPromptAdoption: true,
          },
        }),
      ).rejects.toMatchObject({
        name: "SessionDeliveryDeadLetteredError",
        message: "continuation return refused: recipient-authority-changed",
        keepFailedReceipt: true,
      });

      expect(mocks.isSessionRecipientAuthorityCurrent).toHaveBeenCalledWith(
        // The check reads under the row's owning state dir, not the process env's.
        { agentId: "main", sessionKey, storePath, env: { OPENCLAW_STATE_DIR: testState.stateDir } },
        recipientAuthority,
      );
      expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(mocks.requestContinuationWake).not.toHaveBeenCalled();
    },
  );

  it("preserves distinct durable identities for identical recovered system events", async () => {
    const createEntry = (id: string) =>
      ({
        id,
        kind: "systemEvent",
        sessionKey: "agent:main:main",
        text: "continue after restart",
        // Real continuation returns are written awaiting prompt adoption (targeting.ts);
        // upstream #185730 leaves plain legacy system-event rows inert.
        awaitPromptAdoption: true,
        enqueuedAt: 1,
        retryCount: 0,
      }) as const;

    // Each row is queued as a system event, then deferred until its prompt adopts it.
    for (const id of ["session-delivery-a", "session-delivery-b"]) {
      await expect(
        deliverQueuedSessionDelivery({
          deps: {} as never,
          entry: createEntry(id),
          stateDir: "/tmp/restart-delivery-state",
        }),
      ).rejects.toMatchObject({
        name: "SessionDeliveryDeferredError",
        awaitingAdoptionInMemory: true,
      });
    }

    // Each durable row keeps its own occurrence identity in the queued event.
    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(
      1,
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: "task:restart-sentinel:session-delivery-a",
      }),
    );
    expect(mocks.enqueueSystemEvent).toHaveBeenNthCalledWith(
      2,
      "continue after restart",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        contextKey: "task:restart-sentinel:session-delivery-b",
      }),
    );
  });

  it("replays a main-child continuation return only for its helper recipient", async () => {
    const sessionKey = "agent:helper:return";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "helper",
      entry: undefined,
      store: {},
      storePath: "/tmp/helper-sessions.json",
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    });

    // A continuation return settles only on prompt adoption, including a row
    // written before returns carried awaitPromptAdoption: replay keeps it pending.
    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: "continuation-return-helper-replay",
          kind: "systemEvent",
          sessionKey,
          agentId: "helper",
          text: "main child completed",
          idempotencyKey: "continuation-return:main-child:agent:helper:return",
          enqueuedAt: 1,
          retryCount: 0,
        },
        stateDir: "/tmp/restart-delivery-state",
      }),
    ).rejects.toThrow("system event is awaiting durable prompt adoption");

    const eventOptions = mocks.enqueueSystemEvent.mock.calls[0]?.[1];
    const helperQueueKey = resolveSystemEventQueueKey(sessionKey, "helper");
    expect(eventOptions).toMatchObject({ sessionKey: helperQueueKey });
    // Ownership is the agent-qualified queue key: main cannot derive a queue for this replay.
    expect(() => resolveSystemEventQueueKey(helperQueueKey, "main")).toThrow(
      "System event owner does not match its session key.",
    );
    expect(mocks.requestContinuationWake).toHaveBeenCalledWith({
      sessionKey,
      agentId: "helper",
      reason: "restart-sentinel",
      deliveryIds: ["continuation-return-helper-replay"],
    });
  });

  it.each([
    { name: "missing", agentId: undefined },
    { name: "mismatched", agentId: "main" },
  ])("fails closed when a continuation return recipient owner is $name", async ({ agentId }) => {
    await expect(
      deliverQueuedSessionDelivery({
        deps: {} as never,
        entry: {
          id: `continuation-return-helper-${agentId ?? "missing"}`,
          kind: "systemEvent",
          sessionKey: "agent:helper:return",
          ...(agentId ? { agentId } : {}),
          text: "must not replay",
          idempotencyKey: `continuation-return:invalid-${agentId ?? "missing"}`,
          enqueuedAt: 1,
          retryCount: 0,
        },
      }),
    ).rejects.toThrow(/recipient owner (is unavailable|mismatches)/);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestContinuationWake).not.toHaveBeenCalled();
  });
});
