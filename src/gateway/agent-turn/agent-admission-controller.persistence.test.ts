import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  createAgentRunRestartAbortError,
  resolveAgentRunAbortLifecycleFields,
} from "../../agents/run-termination.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { startSessionWorkAdmissionInterruption } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import * as lifecycleState from "../session-lifecycle-state.js";
import { createAgentAdmissionController } from "./agent-admission-controller.js";
import { createAgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";

const routing = vi.hoisted(() => ({ loadSessionEntry: vi.fn() }));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: routing.loadSessionEntry,
}));

const silentLog: SubsystemLogger = {
  subsystem: "gateway-interruption-persistence-test",
  isEnabled: () => false,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  child: () => silentLog,
};

it.each([
  { name: "ordinary interruption", reason: undefined, status: "killed", recovery: "inactive" },
  {
    name: "explicit restart",
    reason: createAgentRunRestartAbortError(),
    status: "running",
    recovery: "recoverable",
  },
] as const)(
  "persists a registered Gateway admission after $name as $status",
  async ({ reason, status, recovery }) => {
    const state = await createOpenClawTestState({ label: "gateway-interrupt-recovery" });
    const cfg = { agents: { entries: { main: {} } } };
    const target = {
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:main",
    };
    const sessionId = "gateway-interrupt-session";
    const runId = "gateway-interrupt-run";
    const chatRunState = createChatRunState();
    const context = {
      chatRunState,
      chatAbortControllers: new Map(),
      dedupe: new Map(),
      getRuntimeConfig: () => cfg,
      logGateway: silentLog,
    } as unknown as GatewayRequestContext;
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionId,
      sessionKey: target.sessionKey,
      agentId: "main",
      timeoutMs: 60_000,
      kind: "agent",
    });
    const admissionParams = {
      cfg,
      runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      agentDedupeKeys: [`agent:${runId}`],
      context,
      io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
    };
    const admission = createAgentAdmissionController({
      ...admissionParams,
      dedupeLifecycle: createAgentDedupeLifecycle({
        ...admissionParams,
        request: { message: "interrupt this turn", idempotencyKey: runId },
        suppressVisibleSessionEffects: false,
      }),
      getRequestedSessionKey: () => target.sessionKey,
      getResolvedSessionKey: () => target.sessionKey,
      getResolvedSessionId: () => sessionId,
      getResolvedSessionAgentId: () => "main",
      getAgentId: () => "main",
      getCfgForAgent: () => cfg,
      getSessionPersisted: () => true,
      getSupersededSessionId: () => undefined,
      setAdmittedSessionId: (admittedSessionId) => expect(admittedSessionId).toBe(sessionId),
    });
    routing.loadSessionEntry.mockImplementation(() => ({
      ...target,
      canonicalKey: target.sessionKey,
      entry: loadSessionEntry(target),
    }));
    let subscriptions: ReturnType<typeof startGatewayEventSubscriptions> | undefined;
    let interruption: ReturnType<typeof startSessionWorkAdmissionInterruption> | undefined;
    try {
      await replaceSessionEntry(target, { sessionId, updatedAt: 1_000 });
      await admission.acquire(target.storePath);
      admission.setAdmittedRunAbort(registration);
      registration.markExecutionStarted();
      subscriptions = startGatewayEventSubscriptions({
        signal: new AbortController().signal,
        log: silentLog,
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: context.chatAbortControllers,
        restartRecoveryCandidates: new Map(),
        terminalSessions: { closeTaskSessions: vi.fn() },
        refreshConnectedUserProfiles: vi.fn(),
      });
      const persisted = createDeferred();
      const persistLifecycleEvent = lifecycleState.persistGatewaySessionLifecycleEvent;
      const persistenceSpy = vi
        .spyOn(lifecycleState, "persistGatewaySessionLifecycleEvent")
        .mockImplementation((params) => {
          const write = persistLifecycleEvent(params);
          if (params.event.runId === runId && params.event.data?.phase === "error") {
            persisted.resolve(write);
          }
          return write;
        });
      try {
        emitAgentEvent({
          runId,
          sessionId,
          sessionKey: target.sessionKey,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1_000 },
        });
        interruption = startSessionWorkAdmissionInterruption({
          scope: target.storePath,
          identities: [target.sessionKey, sessionId],
          ...(reason ? { reason } : {}),
        });
        expect(registration.controller.signal.aborted).toBe(true);
        emitAgentEvent({
          runId,
          sessionId,
          sessionKey: target.sessionKey,
          stream: "lifecycle",
          data: {
            phase: "error",
            endedAt: 2_000,
            ...resolveAgentRunAbortLifecycleFields(registration.controller.signal),
          },
        });
        registration.cleanup();
        admission.release();
        await interruption.released;
        await persisted.promise;
        closeOpenClawAgentDatabasesForTest();
        const restored = loadSessionEntry({ ...target, readConsistency: "latest" });
        expect(restored).toMatchObject({ status, abortedLastRun: true });
        if (!restored) {
          throw new Error("session was not persisted");
        }
        expect(
          transitionMainSessionRecovery(restored, {
            kind: "observe",
            cycleId: "next-gateway-cycle",
            lifecycleGeneration: "next-gateway-generation",
            sessionKey: target.sessionKey,
          }),
        ).toMatchObject({ kind: "observed", view: { status: recovery } });
      } finally {
        persistenceSpy.mockRestore();
      }
    } finally {
      admission.release();
      await interruption?.released;
      registration.cleanup();
      await subscriptions?.agentUnsub();
      subscriptions?.heartbeatUnsub();
      subscriptions?.transcriptUnsub();
      subscriptions?.lifecycleUnsub();
      await subscriptions?.taskUnsub();
      routing.loadSessionEntry.mockReset();
      await state.cleanup();
    }
  },
);
