import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as termination from "../agents/run-termination.js";
import { createAgentLifecycleTerminalBackstop } from "../auto-reply/reply/agent-lifecycle-terminal.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContextOwnerStatus,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import {
  startSessionControllerInterruption,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createAgentAdmissionController } from "./agent-turn/agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createChatRunState, createSessionEventSubscriberRegistry } from "./server-chat-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import * as projection from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-restart-terminal-");

beforeEach(() => {
  const cfg = {};
  setRuntimeConfigSnapshot(cfg, cfg);
});

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("./session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => {
    const loaded = await routing.loadSessionEntry(
      params.key,
      { agentId: params.agentId },
      params.cfg,
    );
    return { ...loaded, storeKeys: loaded.storeKeys ?? [loaded.canonicalKey] };
  },
}));

const subscriptionFixture = createSubscriptionTestFixture();
const persistenceTestWarnings = subscriptionFixture.warn;
const silentLog: typeof subscriptionFixture.log = {
  ...subscriptionFixture.log,
  subsystem: "gateway-lifecycle-persistence-test",
  isEnabled: () => false,
  child: () => silentLog,
};

function createTarget(sessionKey: string) {
  const target = { storePath: path.join(tempDirs.make(), "sessions.json"), sessionKey };
  routing.loadSessionEntry.mockImplementation(() => ({
    ...target,
    canonicalKey: sessionKey,
    entry: loadSessionEntry(target),
  }));
  return target;
}

async function closeStore(root: string) {
  await agentDb.closeOpenClawAgentDatabasesAsync(root);
  agentDb.closeOpenClawAgentDatabasesForTest(root);
}

type Subscriptions = ReturnType<typeof startGatewayEventSubscriptions>;
function subscribe(
  chatRunState: ReturnType<typeof createChatRunState>,
  overrides: Partial<Parameters<typeof startGatewayEventSubscriptions>[0]> = {},
) {
  return startGatewayEventSubscriptions({
    ...subscriptionFixture.createParams(),
    log: silentLog,
    chatRunState,
    toolEventRecipients: chatRunState.toolEventRecipients,
    ...overrides,
  });
}

async function stopSubscriptions(subscriptions: Subscriptions | undefined) {
  await subscriptions?.agentUnsub();
  heartbeatNotifications.onEvent = () => {};
  subscriptions?.transcriptUnsub();
  subscriptions?.lifecycleUnsub();
}

it("persists current-run timing after pre-start failure and clears it on the next run", async () => {
  const target = createTarget("agent:main:timing");
  let now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  let persistence = Promise.resolve();
  const unsubscribe = onAgentEvent((event) => {
    if (event.sessionKey === target.sessionKey && event.stream === "lifecycle") {
      persistence = persistence.then(() =>
        lifecycleState.persistGatewaySessionLifecycleEvent({
          sessionKey: target.sessionKey,
          event,
        }),
      );
    }
  });
  const createBackstop = (runId: string) =>
    createAgentLifecycleTerminalBackstop({
      runId,
      sessionKey: target.sessionKey,
      getLifecycleGeneration: getAgentEventLifecycleGeneration,
      resolveTerminationFields: () => ({}),
    });
  const start = (runId: string) => {
    const backstop = createBackstop(runId);
    const data = { phase: "start", startedAt: now };
    emitAgentEvent({ runId, sessionKey: target.sessionKey, stream: "lifecycle", data });
    backstop.note({ stream: "lifecycle", data });
    return backstop;
  };
  try {
    await replaceSessionEntry(target, { sessionId: "timing-session", updatedAt: now });
    const previous = start("timing-persisted-previous");
    now += 11_192;
    previous.emit("end", { meta: {} });
    await persistence;
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 1_000_000,
      runtimeMs: 11_192,
    });

    now = 3_475_979;
    const failed = createBackstop("timing-persisted-failed");
    now += 4_700;
    failed.emit("error", new Error("preparation failed"));
    await persistence;
    expect.soft(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      startedAt: 3_475_979,
      endedAt: 3_480_679,
      runtimeMs: 4_700,
      lastRunError: "preparation failed",
      lastRunId: "timing-persisted-failed",
    });

    now = 3_600_000;
    const recovered = start("timing-persisted-recovered");
    await persistence;
    const running = loadSessionEntry(target);
    expect(running).toMatchObject({ startedAt: 3_600_000 });
    expect(running?.status).toBeUndefined();
    expect(running?.runtimeMs).toBeUndefined();
    expect(running?.endedAt).toBeUndefined();
    expect(running?.lastRunError).toBeUndefined();
    now += 11_192;
    recovered.emit("end", { meta: {} });
    await persistence;
    await closeStore(path.dirname(target.storePath));
    expect(loadSessionEntry(target)).toMatchObject({
      status: "done",
      startedAt: 3_600_000,
      endedAt: 3_611_192,
      runtimeMs: 11_192,
      lastRunId: "timing-persisted-recovered",
    });
  } finally {
    unsubscribe();
    await persistence;
    clock.mockRestore();
    routing.loadSessionEntry.mockReset();
    await closeStore(path.dirname(target.storePath));
  }
});

it.each(["success", "failed-write"])(
  "settles native child cancellation through %s without retry grace",
  async (outcome) => {
    const state = await createOpenClawTestState({ label: "native-cancel-lifecycle" });
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg, cfg);
    const target = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:subagent:native-cancel",
    };
    const sessionId = "native-cancel-session";
    const runId = "native-cancel-run";
    const emitLifecycle = (data: Record<string, unknown>) =>
      emitAgentEvent({
        runId,
        sessionId,
        sessionKey: target.sessionKey,
        stream: "lifecycle",
        data,
      });
    const chatRunState = createChatRunState();
    const broadcast = vi.fn();
    const terminalChanged = createDeferred();
    const broadcastToConnIds = vi.fn<GatewayRequestContext["broadcastToConnIds"]>(
      (event, payload) => {
        if (
          event === "sessions.changed" &&
          isRecord(payload) &&
          payload.runId === runId &&
          payload.status === "killed"
        ) {
          terminalChanged.resolve();
        }
      },
    );
    const context = {
      chatRunState,
      dedupe: new Map(),
      getRuntimeConfig: () => cfg,
      logGateway: silentLog,
    } as unknown as GatewayRequestContext;
    const sourceFinished = createDeferred();
    const registration = registerChatAbortController({
      target: captureSessionTarget({
        storeScope: target.storePath,
        sessionKey: target.sessionKey,
        incarnation: sessionId,
        agentId: "main",
      }),
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      agentId: "main",
      timeoutMs: 60_000,
      kind: "agent",
      sourceWork: sourceFinished.promise,
    });
    const admissionParams = {
      cfg,
      runId,
      agentDedupeKeys: [`agent:${runId}`],
      context,
      io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
    };
    let admissionEntry: SessionEntry | undefined = { sessionId, updatedAt: 1_000 };
    const admission = createAgentAdmissionController({
      ...admissionParams,
      dedupeLifecycle: createAgentDedupeLifecycle({
        ...admissionParams,
        request: { message: "cancel this child", idempotencyKey: runId },
        suppressVisibleSessionEffects: false,
      }),
      getRequestedSessionKey: () => target.sessionKey,
      getResolvedSessionKey: () => target.sessionKey,
      getResolvedSessionId: () => sessionId,
      getSessionEntry: () => admissionEntry,
      setSessionEntry: (entry) => {
        admissionEntry = entry;
      },
      getResolvedSessionAgentId: () => "main",
      getAgentId: () => "main",
      getSessionPersisted: () => true,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: (admittedSessionId) => expect(admittedSessionId).toBe(sessionId),
    });
    admission.setAdmittedRunAbort(registration);
    registration.initializeTiming();
    const entry = expectDefined(registration.entry, "registered child");
    const producer = await claimSessionControllerTask(entry.input, (mailboxClaim) => {
      const operation = createReplyOperation({
        sessionKey: target.sessionKey,
        sessionId,
        agentId: "main",
        resetTriggered: false,
        mailboxClaim,
        target: entry.input.mailbox.owner.target,
      });
      markReplyOperationExecutionStarted(operation);
    });
    const releaseProducer = () => {
      producer.operation?.complete();
      releaseSessionControllerClaim(producer);
    };
    expect(registration.markExecutionStarted()).toBe(true);
    const [startPersisted, terminalWrite] = [createDeferred(), createDeferred()] as const;
    let persistenceSpy:
      | MockInstance<typeof lifecycleState.prepareGatewaySessionLifecycleEvent>
      | undefined;
    const [writerStarted, releaseWriter] = [createDeferred(), createDeferred()] as const;
    let heldWriter: Promise<unknown> | undefined;
    let subscriptions: Subscriptions | undefined;
    let interruption: ReturnType<typeof startSessionControllerInterruption> | undefined;
    const actual = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    routing.loadSessionEntry.mockImplementation((key, options, sourceCfg) =>
      actual.loadGatewaySessionEntryReadOnlyInWorker({
        cfg: sourceCfg,
        key,
        ...options,
        excludeInternalEffects: true,
        readOnly: false,
      }),
    );
    const readSessionInfo = async () => {
      const respond = vi.fn();
      await chatHistoryHandlers["chat.history"]!({
        req: { type: "req", id: "native-cancel-history", method: "chat.history" },
        params: { sessionKey: target.sessionKey, agentId: "main" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1]?.sessionInfo;
    };
    try {
      admissionEntry =
        (await replaceSessionEntry(target, {
          sessionId,
          spawnedBy: "agent:main:main",
          updatedAt: 1_000,
        })) ?? undefined;
      await admission.acquire(target.storePath);
      const rowProjection = await createSessionRowProjection({ cfg, context });
      projection.bindSessionRowProjection(context, () => rowProjection);
      const sessionEventSubscribers = createSessionEventSubscriberRegistry();
      sessionEventSubscribers.subscribe("session-observer");
      subscriptions = subscribe(chatRunState, {
        getSessionRowProjection: () => projection.getSessionRowProjection(context),
        broadcast,
        broadcastToConnIds,
        sessionEventSubscribers,
      });
      const prepareLifecycleEvent = lifecycleState.prepareGatewaySessionLifecycleEvent;
      persistenceSpy = vi
        .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
        .mockImplementation((params) => {
          const persist = prepareLifecycleEvent(params);
          return () => {
            const persistence = persist();
            if (params.event.runId === runId && params.event.data?.phase === "start") {
              startPersisted.resolve(persistence);
            }
            return persistence;
          };
        });
      emitLifecycle({ phase: "start", startedAt: 1_000 });
      // Join the real commit across lazy handler loading, not a polling deadline.
      await startPersisted.promise;
      expect(loadSessionEntry(target)?.status).toBeUndefined();
      expect(await readSessionInfo()).toMatchObject({
        status: "running",
        hasActiveRun: true,
        activeRunIds: [runId],
      });
      heldWriter = patchSessionEntryCore(target, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
        return null;
      });
      await writerStarted.promise;
      if (outcome === "failed-write") {
        persistenceSpy.mockReturnValueOnce(() => terminalWrite.promise);
      }

      interruption = startSessionControllerInterruption({
        scope: target.storePath,
        identities: [target.sessionKey, sessionId],
        reason: termination.createAgentRunDirectAbortError(),
      });
      expect(registration.controller.signal.aborted).toBe(true);
      emitLifecycle({
        phase: "error",
        ...termination.resolveAgentRunAbortLifecycleFields(registration.controller.signal),
        endedAt: 2_000,
      });
      await vi.waitFor(() =>
        expect(entry.adapter.projectSessionTerminalPersistence).toBeInstanceOf(Promise),
      );
      const terminalPersistence = entry.adapter.projectSessionTerminalPersistence;
      releaseProducer();
      registration.cleanup();
      admission.release();
      expect(chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
      expect(rpcSourceTesting.get(runId)).toBe(entry);
      expect(registration.entry?.adapter.projectSessionTerminalPersistence).toBeInstanceOf(Promise);
      expect(
        resolveVisibleActiveSessionRunState({
          storePath: target.storePath,
          resolveGatewayContext: context.resolveGatewayContext,
          requestedKey: target.sessionKey,
          canonicalKey: target.sessionKey,
          sessionId,
          agentId: "main",
        }),
      ).toEqual({ active: false, runIds: [] });
      expect(await readSessionInfo()).toMatchObject({ status: "running", hasActiveRun: true });

      if (outcome === "failed-write") {
        const removed = waitForChatAbortControllerRemoval({
          targets: [{ runId, entry }],
          timeoutMs: 1_000,
        });
        terminalWrite.reject(new Error("terminal write failed"));
        await expect(terminalPersistence).rejects.toThrow("terminal write failed");
        sourceFinished.resolve();
        registration.cleanup();
        await expect(producer.settlement.promise).rejects.toMatchObject({
          message: "Source cleanup failed",
          errors: [expect.objectContaining({ message: "terminal write failed" })],
        });
        await expect(interruption.released).rejects.toThrow("Source cleanup failed");
        expect(await removed).toBe(false);
        expect(entry.adapter.projectSessionTerminalPersisted).toBe(false);
        expect(loadSessionEntry(target)?.status).toBeUndefined();
        return;
      }
      releaseWriter.resolve();
      await heldWriter;
      await terminalPersistence;
      sourceFinished.resolve();
      registration.cleanup();
      await interruption.released;
      await vi.waitFor(() => expect(rpcSourceTesting.has(runId)).toBe(false));
      await vi.waitFor(() =>
        expect(broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "aborted", stopReason: "aborted" }),
          expect.anything(),
        ),
      );
      expect(await readSessionInfo()).toMatchObject({
        status: "killed",
        hasActiveRun: false,
        activeRunIds: [],
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
        abortedLastRun: true,
      });
      await terminalChanged.promise;
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ runId, status: "killed", hasActiveRun: false, runtimeMs: 1_000 }),
        new Set(["session-observer"]),
        {
          dropIfSlow: true,
          sessionEventSubscriptionKeys: [target.sessionKey],
          prepareSessionProjection: expect.any(Function),
        },
      );
      await closeStore(state.root);
      const restored = loadSessionEntry({ ...target, readConsistency: "latest" });
      expect(restored).toMatchObject({
        status: "killed",
        lastRunId: runId,
        endedAt: 2_000,
        runtimeMs: 1_000,
      });
      expect(restored?.lifecycleRunId).toBeUndefined();
    } finally {
      releaseProducer();
      admission.release();
      terminalWrite.resolve();
      releaseWriter.resolve();
      await heldWriter;
      sourceFinished.resolve();
      registration.cleanup();
      await Promise.allSettled([
        producer.settlement.promise,
        ...(interruption ? [interruption.released] : []),
      ]);
      await stopSubscriptions(subscriptions);
      projection.getSessionRowProjection(context)?.dispose();
      registration.cleanup();
      persistenceSpy?.mockRestore();
      routing.loadSessionEntry.mockReset();
      await state.cleanup();
    }
  },
);

const ownerClaimFixture = createFixtureLifetime();
afterEach(async () => {
  // Vitest may finish its timeout wrapper before the body retires its owners.
  await ownerClaimFixture.cleanup();
});

it.for([
  ["end", "end", {}, "done"],
  ["cancellation", "error", { aborted: true, stopReason: "aborted" }, "killed"],
  ["settled failure", "error", { executionSettled: true, error: "Preparation failed" }, "failed"],
] as const)(
  "keeps an owner claim active until its queued %s write commits",
  ([, phase, data, status], { signal }) =>
    ownerClaimFixture.run(async () => {
      const target = createTarget("agent:main:worker-terminal");
      const runId = "worker-terminal-run";
      const sessionId = "worker-terminal-session";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const [writerStarted, releaseWriter] = [createDeferred(), createDeferred()] as const;
      const clearRequested = createDeferred<string>();
      let claimId: string | undefined;
      let subscriptions: Subscriptions | undefined;
      let heldWriter: Promise<unknown> | undefined;
      persistenceTestWarnings.mockReset();
      try {
        await replaceSessionEntry(target, {
          lifecycleRunId: runId,
          sessionId,
          startedAt: 1_000,
          updatedAt: 1_000,
        });
        heldWriter = patchSessionEntryCore(target, async () => {
          writerStarted.resolve();
          await releaseWriter.promise;
          return null;
        });
        await writerStarted.promise;
        claimId = claimAgentRunContext(
          runId,
          { lifecycleGeneration, sessionId, sessionKey: target.sessionKey },
          {
            exclusive: true,
            ownsContext: true,
            trackOwner: true,
            onClearRequested: clearRequested.resolve,
          },
        );
        const terminalClaimId = expectDefined(claimId, "worker terminal claim");
        const ownerStatus = () =>
          getAgentRunContextOwnerStatus(runId, terminalClaimId, lifecycleGeneration);
        const chatRunState = createChatRunState();
        const markFinal = vi.spyOn(chatRunState.toolEventRecipients, "markFinal");
        subscriptions = subscribe(chatRunState);

        emitAgentEventForOwner(
          {
            runId,
            sessionId,
            sessionKey: target.sessionKey,
            stream: "lifecycle",
            data: { phase, ...data, startedAt: 1_000, endedAt: 2_000 },
          },
          terminalClaimId,
        );
        await vi.waitFor(
          () =>
            expect(
              markFinal.mock.calls.length + persistenceTestWarnings.mock.calls.length,
            ).toBeGreaterThan(0),
          { timeout: 10_000 },
        );
        expect(persistenceTestWarnings).not.toHaveBeenCalled();
        expect(markFinal).toHaveBeenCalledWith(runId);

        expect(ownerStatus()).toBe("active");
        releaseWriter.resolve();
        await heldWriter;
        // Failed runs also persist a transcript receipt after the row update.
        expect(await racePromiseWithAbortSignal(clearRequested.promise, signal)).toBe(
          terminalClaimId,
        );
        expect(persistenceTestWarnings).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.status).toBe(status);
        if (status === "failed") {
          await expect(loadTranscriptEvents({ ...target, sessionId })).resolves.toContainEqual(
            expect.objectContaining({
              type: "custom_message",
              customType: "run-failed-before-reply",
              content: "Your request couldn't be completed.",
              display: true,
              details: { runId, error: "Preparation failed" },
            }),
          );
        }
        expect(ownerStatus()).toBe("clear-requested");
      } finally {
        releaseWriter.resolve();
        await heldWriter;
        await stopSubscriptions(subscriptions);
        releaseAgentRunContext(runId, claimId);
        routing.loadSessionEntry.mockReset();
        await closeStore(path.dirname(target.storePath));
      }
    }),
);
