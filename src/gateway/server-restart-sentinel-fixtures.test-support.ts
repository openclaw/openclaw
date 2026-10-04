import { afterEach, beforeEach, vi } from "vitest";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  actualRestartUpdateRun,
  deliverQueuedSessionDelivery,
  mocks,
  recoverPendingRestartContinuationDeliveries,
  settleQueuedSessionDelivery,
  resetGatewayWorkAdmission,
  scheduleRestartSentinelWake,
  type LoadedSessionEntry,
  type RestartSentinel,
} from "./server-restart-sentinel.test-harness.js";
import {
  createGeneratedMediaDeliveryEntry,
  createRestartSentinelSessionFixture as sessionFixture,
  expectContinuationDispatchFields as assertContinuationDispatchFields,
  expectCapturedQueueContext,
} from "./server-restart-sentinel.test-support.js";
import * as restartUpdateRun from "./server-restart-update-run.js";

export type { LoadedSessionEntry, RestartSentinel };

export { createRestartSentinelSessionFixture as sessionFixture } from "./server-restart-sentinel.test-support.js";

export function sentinelFixture(payload: RestartSentinelPayload, revision = 123): RestartSentinel {
  return { version: 1, revision, payload };
}

export function createRestartSentinelTestFixture() {
  const expectContinuationDispatchFields = assertContinuationDispatchFields.bind(
    null,
    mocks.recordInboundSessionAndDispatchReply,
  );

  function deliverGeneratedMedia(
    overrides: Parameters<typeof createGeneratedMediaDeliveryEntry>[0],
    stateDir?: string,
    resolveGatewayContext?: () => undefined,
  ) {
    return deliverQueuedSessionDelivery({
      deps: {} as never,
      queueContext:
        stateDir === undefined
          ? queueContext
          : captureOpenClawStateWorkerContext({
              env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
            }),
      ...(resolveGatewayContext ? { resolveGatewayContext } : {}),
      entry: createGeneratedMediaDeliveryEntry(overrides),
    });
  }

  function mockRestartContinuation(
    continuation: NonNullable<RestartSentinelPayload["continuation"]>,
    threadId?: string,
    revision?: number,
  ) {
    mocks.readRestartSentinel.mockResolvedValue({
      ...(revision === undefined ? {} : { version: 1, revision }),
      payload: {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
        ...(threadId === undefined ? {} : { threadId }),
        ts: 123,
        continuation,
      },
    } as Awaited<ReturnType<typeof mocks.readRestartSentinel>>);
  }

  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let testState: OpenClawTestState;
  let queueContext: OpenClawStateWorkerContext;

  function wakeRestartSentinel() {
    return scheduleRestartSentinelWake({ scheduler, signal: scheduler.signal, deps: {} });
  }

  function expectQueueContext(stateDir = testState.stateDir) {
    return expectCapturedQueueContext(stateDir);
  }

  function setNoticeOwner(owner: string) {
    mocks.getRuntimeConfig.mockReturnValue({
      ...mocks.getRuntimeConfig(),
      commands: { ownerAllowFrom: [owner] },
    });
  }

  afterEach(async () => {
    await scheduler.stop();
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    await testState.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
    vi.mocked(restartUpdateRun.finalizeRestartUpdateRun)
      .mockReset()
      .mockImplementation(actualRestartUpdateRun.finalizeRestartUpdateRun);
    testState = await createOpenClawTestState({
      label: "gateway-restart-sentinel",
      layout: "state-only",
    });
    resetGatewayWorkAdmission();
    queueContext = captureOpenClawStateWorkerContext();
    vi.useRealTimers();
    mocks.setInitialOutboundDelivery(null);
    mocks.getRuntimeConfig.mockReturnValue({ commands: { ownerAllowFrom: ["+15550002"] } });
    mocks.resolveSessionTarget.mockImplementation(async ({ key, agentId, env, assertActive }) => {
      assertActive?.();
      const loaded = mocks.loadSessionEntry(key, { agentId, env });
      return {
        ...loaded,
        agentId: loaded.agentId ?? "main",
        store: loaded.entry
          ? { ...loaded.store, [loaded.canonicalKey]: loaded.entry }
          : loaded.store,
      };
    });
    mocks.captureSessionEventTarget.mockReset();
    mocks.captureSessionEventTarget.mockImplementation(
      async (agentId: string, sessionKey: string) => ({
        agentId,
        sessionKey,
        sessionId: sessionKey,
        generation: "restart-sentinel-test",
      }),
    );
    mocks.enqueueSessionEvent.mockReset();
    mocks.enqueueSessionEvent.mockImplementation((_text, options) => ({
      id: "restart-event",
      cancel: () => true,
      settled: Promise.resolve().then(async () => {
        await options.onAdopted?.();
        return { status: "completed", executionStarted: true, delivered: false };
      }),
    }));
    mocks.dispatchGatewayMethodInProcess.mockReset();
    mocks.dispatchGatewayMethodInProcess.mockResolvedValue({
      status: "ok",
      result: {
        payloads: [{ text: "ready", mediaUrls: ["/tmp/proof.png"] }],
        deliveryStatus: { status: "sent" },
      },
    });
    mocks.readRestartSentinel.mockReset();
    mocks.readRestartSentinel.mockResolvedValue(
      sentinelFixture({
        kind: "restart",
        status: "ok",
        ts: 123,
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "whatsapp",
          to: "+15550002",
          accountId: "acct-2",
        },
      }),
    );
    mocks.parseSessionThreadInfo.mockReset();
    mocks.parseSessionThreadInfo.mockReturnValue({ baseSessionKey: null, threadId: undefined });
    mocks.loadSessionEntry.mockReset();
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) =>
      sessionFixture(
        sessionKey,
        { sessionId: sessionKey, updatedAt: 0 },
        { cfg: { commands: { ownerAllowFrom: ["+15550002"] } }, agentId: "main" },
      ),
    );
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue(undefined);
    mocks.getChannelPlugin.mockReset();
    mocks.getChannelPlugin.mockReturnValue(undefined);
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
    mocks.loadPendingDelivery.mockReset();
    mocks.loadPendingDelivery.mockResolvedValue(null);
    mocks.appendAssistantMessageToSessionTranscript.mockReset();
    mocks.createManagedOutgoingMediaBlocks.mockReset();
    mocks.attachManagedOutgoingMediaToMessage.mockReset();
    mocks.enrichAssistantTranscriptMediaForRun.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockReset();
    mocks.finalizeUpdateRestartSentinelRunningVersion.mockResolvedValue(null);
    mocks.clearSentinel.mockReset();
    mocks.clearSentinel.mockResolvedValue(true);
    mocks.resolveSystemMainSessionTarget.mockReset();
    mocks.resolveSystemMainSessionTarget.mockReturnValue({
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    mocks.recordInboundSessionAndDispatchReply.mockReset();
    mocks.recordInboundSessionAndDispatchReply.mockResolvedValue(undefined);
  });

  return {
    mocks,
    actualRestartUpdateRun,
    recoverPendingRestartContinuationDeliveries,
    settleQueuedSessionDelivery,
    get clock() {
      return clock;
    },
    get scheduler() {
      return scheduler;
    },
    get testState() {
      return testState;
    },
    get queueContext() {
      return queueContext;
    },
    deliverGeneratedMedia,
    expectContinuationDispatchFields,
    expectQueueContext,
    mockRestartContinuation,
    setNoticeOwner,
    wakeRestartSentinel,
  };
}
