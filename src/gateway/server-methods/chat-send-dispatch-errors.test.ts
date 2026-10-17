import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSelectedAuthProfileUnavailableError } from "../../agents/auth-profiles/selection-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { DispatchSessionRefreshRequiredError } from "../../auto-reply/reply/dispatch-session-refresh-error.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { getAgentEventLifecycleGeneration, onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  getTerminalSessionWorkAdmissionRelease,
} from "../../sessions/session-lifecycle-admission.js";
import * as sessionRunError from "../../sessions/session-run-error.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../state/agent-database-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { markChatAbortTerminalOutcome } from "../chat-abort-lifecycle-internal.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { DedupeEntry } from "../server-shared.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
import { broadcastChatDelta } from "./chat-broadcast.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import {
  createChatSendDispatchErrorLifecycle,
  handleChatSendSetupError,
} from "./chat-send-dispatch-errors.js";

const policyMessage =
  "OpenCode cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.";

function expectNoError(broadcast: ReturnType<typeof vi.fn>, runId: string) {
  expect(broadcast).not.toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ runId, state: "error" }),
    expect.anything(),
  );
}

async function captureTerminalTarget(scope: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
}) {
  return withSessionEntriesFromStoresInWorker(
    [
      {
        ...scope,
        agentId: scope.agentId ?? "main",
        sessionKeys: [scope.sessionKey],
        projection: "exact",
      },
    ],
    ([read]) => {
      const source = read!.result.source;
      if (!source) {
        throw new Error("Expected an admitted physical session source");
      }
      return {
        target: {
          ...scope,
          readSource: source,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        },
        expectedLifecycleRevision: read!.result.entries[0]?.entry.lifecycleRevision,
        assertCurrent: vi.fn(),
      };
    },
    { ordered: true },
  );
}

function expectLastError(broadcast: ReturnType<typeof vi.fn>, errorMessage: string) {
  expect(broadcast).toHaveBeenLastCalledWith(
    "chat",
    expect.objectContaining({ errorMessage }),
    expect.anything(),
  );
}

function createContext() {
  return {
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    chatRunState: createChatRunState(),
    dedupe: new Map<string, DedupeEntry>(),
    logGateway: { warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(),
  };
}

function registerRun(runId: string) {
  const sessionKey = "agent:main:main";
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionId: "sess-main",
    sessionKey,
    timeoutMs: 60_000,
  });
  if (!registration.registered) {
    throw new Error("expected the chat abort controller to be registered");
  }
  return { sessionKey, chatAbortControllers, registration, context: createContext() };
}

function createSessionBinding(sessionId = "sess-main", lifecycleGeneration = "test-generation") {
  return { sessionId, sessionKey: "agent:main:main", agentId: "main", lifecycleGeneration };
}

it.each([
  new GatewayDrainingError(),
  new SessionTranscriptProjectionUnavailableError("sess-main"),
  new AgentDatabaseAdmissionError(
    createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: ["/isolated/main.sqlite"],
      reason: "Inspection continues in the background.",
      pending: true,
    }),
  ),
])("returns %s to the retry owner without broadcasting a terminal", async (error) => {
  const cleanupAdmittedRun = vi.fn();
  const context = createContext();
  const { broadcast, dedupe } = context;
  const respond = vi.fn();
  const terminalizeRestartSafeAdmission = vi.fn();
  const restart = error instanceof GatewayDrainingError;
  if (restart) {
    markGatewayRestartDraining();
  }

  await handleChatSendSetupError({
    admission: {
      sessionBinding: createSessionBinding(),
      cleanupAdmittedRun,
      lifecycleGeneration: "test-generation",
      restartSafeAdmission: restart ? { requestFingerprint: "restart" } : undefined,
    },
    context: context as never,
    error,
    respond,
    session: {
      agentId: "main",
      clientRunId: "setup-projection-retry",
      sessionKey: "agent:main:main",
    },
    terminalizeRestartSafeAdmission,
  }).finally(() => {
    if (restart) {
      resetGatewayWorkAdmission();
    }
  });

  expect(terminalizeRestartSafeAdmission).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    expect.objectContaining({ runId: "setup-projection-retry", status: "error" }),
    expect.objectContaining({ code: "UNAVAILABLE", retryable: true, retryAfterMs: 250 }),
    expect.anything(),
  );
  expect(dedupe.size).toBe(0);
  expect(broadcast).not.toHaveBeenCalled();
  expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
  if (error instanceof AgentDatabaseAdmissionError) {
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ details: error.refusal });
  }
});

type LifecycleParams = Parameters<typeof createChatSendDispatchErrorLifecycle>[0];

function createAbort(controller = new AbortController(), cleanup = vi.fn()) {
  return { controller, cleanup, entry: undefined, registered: true } as never;
}

function createLifecycle({
  admission,
  context,
  session,
  ...overrides
}: Omit<Partial<LifecycleParams>, "admission" | "context" | "session"> & {
  admission?: Partial<LifecycleParams["admission"]>;
  context: LifecycleParams["context"];
  session: Partial<LifecycleParams["session"]>;
}) {
  return createChatSendDispatchErrorLifecycle({
    admission: {
      sessionBinding: createSessionBinding(),
      activeRunAbort: createAbort(),
      cleanupAdmittedRun: vi.fn(),
      lifecycleGeneration: "test-generation",
      restartSafeAdmission: undefined,
      ...admission,
    },
    context: { getRuntimeConfig: () => ({}), ...context } as never,
    session: {
      agentId: "main",
      backingSessionId: "sess-main",
      cfg: {},
      now: 1,
      rawSessionKey: "agent:main:main",
      sessionKey: "agent:main:main",
      clientRunId: "run-1",
      ...session,
    },
    isQueuedFollowupEnqueued: () => false,
    isAgentRunStarted: () => false,
    persistUserTurnTranscript: vi.fn(),
    terminalizeRestartSafeAdmission: vi.fn(),
    userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
    ...overrides,
  });
}

it.each(
  (["fallback", "restart-safe"] as const).flatMap((settlement) =>
    (["worker", "busy", "restart", "profile", "policy", "changed"] as const).map((failureKind) => ({
      settlement,
      failureKind,
    })),
  ),
)("records $settlement rejection: $failureKind", async ({ settlement, failureKind }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "dispatch-failure-session",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const runId = "dispatch-failure-run";
    const lifecycleGeneration =
      failureKind === "restart" ? getAgentEventLifecycleGeneration() : "test-generation";
    const restartSafe = settlement === "restart-safe";
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1_000,
      startedAt: 1_000,
      lifecycleRunId: runId,
      ...(restartSafe
        ? { restartRecoveryDeliveryRunId: runId, restartRecoveryDeliverySourceRunId: runId }
        : {}),
    });
    let userPersisted = false;
    const persistUserTurnTranscript = async () => {
      await appendTranscriptMessage(target, {
        message: { role: "user", content: "Please continue." },
      });
      userPersisted = true;
    };
    if (restartSafe) {
      await persistUserTurnTranscript();
    }
    const terminalTarget = await captureTerminalTarget(target);
    const context = {
      ...createContext(),
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    };
    const { broadcast, chatRunState } = context;
    const warn = context.logGateway.warn;
    broadcastChatDelta({
      context,
      runId,
      sessionKey: target.sessionKey,
      text: "Command instructions",
      isCurrent: () => true,
    });
    const previewGroup = chatRunState.runs.get(runId)?.liveTextGroup;
    const lifecycle = createLifecycle({
      admission: {
        sessionBinding: createSessionBinding(target.sessionId, lifecycleGeneration),
        lifecycleGeneration,
        restartSafeAdmission: restartSafe ? { requestFingerprint: "test-fingerprint" } : undefined,
      },
      context,
      persistUserTurnTranscript,
      session: { backingSessionId: target.sessionId, clientRunId: runId, now: 1_000 },
      terminalizeRestartSafeAdmission: (terminal) =>
        terminalizeRestartSafeChatAdmission({
          ...terminal,
          ...terminalTarget,
          admittedSessionId: target.sessionId,
          clientRunId: runId,
          startedAt: 1_000,
        }),
      userTurnRecorder: { hasPersisted: () => userPersisted, isBlocked: () => false },
    });

    const failure =
      failureKind === "restart"
        ? new GatewayDrainingError()
        : failureKind === "busy"
          ? Object.assign(new Error("database is locked"), {
              code: "ERR_SQLITE_ERROR",
              errcode: 5,
            })
          : failureKind === "changed"
            ? new DispatchSessionRefreshRequiredError(
                new Error(`Session "${target.sessionKey}" changed while starting work. Retry.`),
              )
            : failureKind === "profile"
              ? createSelectedAuthProfileUnavailableError({
                  profileId: "openai:removed",
                  provider: "openai",
                  modelId: "fixture-model",
                })
              : failureKind === "policy"
                ? new AgentHarnessPreflightError("private-policy-diagnostic", {
                    userMessage: policyMessage,
                  })
                : new Error("Cloud worker unavailable");
    if (failureKind === "restart") {
      markGatewayRestartDraining();
    }
    try {
      await lifecycle.handleError(failure);
      expect(previewGroup?.signal.aborted).toBe(false);
      await lifecycle.finalize();
    } finally {
      if (failureKind === "restart") {
        resetGatewayWorkAdmission();
      }
    }
    expect(broadcast).toHaveBeenLastCalledWith(
      "chat",
      expect.objectContaining(
        failureKind === "restart"
          ? { state: "aborted", stopReason: "restart" }
          : { state: "error" },
      ),
      {
        liveText: {
          group: previewGroup?.signal,
          settle: failureKind === "restart" ? undefined : true,
        },
        sessionKeys: [target.sessionKey],
      },
    );
    expect(chatRunState.runs.has(runId)).toBe(false);
    expect(previewGroup?.signal.aborted).toBe(true);

    expect(warn).not.toHaveBeenCalled();
    const stored = loadSessionEntry(target);
    expect(stored).toMatchObject({
      status: failureKind === "restart" ? "interrupted" : "failed",
      lastRunId: runId,
    });
    const messages = (await loadTranscriptEvents(target)).filter(
      (entry) => isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
    );
    if (failureKind === "restart") {
      expect(messages).toEqual([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user", content: "Please continue." }),
        }),
      ]);
      expect(stored).toMatchObject({ abortedLastRun: true });
      if (restartSafe) {
        expect(stored?.restartRecoveryDeliverySourceRunId).toBe(runId);
      }
      return;
    }
    expect(messages).toMatchObject([
      { type: "message", message: { role: "user", content: "Please continue." } },
      {
        type: "custom_message",
        customType: "run-failed-before-reply",
        display: true,
        details: { runId },
      },
    ]);
    if (failureKind === "busy") {
      const summary =
        "Your request was interrupted while the server was busy. Check its status before trying again.";
      const terminal = broadcast.mock.calls.at(-1)?.[1];
      expect(terminal).toMatchObject({
        errorKind: "state_contention",
        errorMessage: expect.stringMatching(new RegExp(`^${summary.replaceAll(".", "\\.")}`)),
      });
      expect(stored?.lastRunError).toBe(summary);
      expect(messages[1]).toMatchObject({
        content: summary,
        details: { errorKind: "state_contention" },
      });
    }
    if (failureKind === "profile") {
      const recovery = renderFailoverCodeUserCopy("selected_auth_profile_unavailable")!;
      expect(stored?.lastRunError).toBe(recovery);
      expect(JSON.stringify(messages)).toContain(recovery);
      expect(JSON.stringify(messages)).not.toContain("openai:removed");
      expectLastError(broadcast, recovery);
    }
    if (failureKind === "changed") {
      const recovery =
        "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
      expectLastError(broadcast, `${recovery}\n\n${String(failure)}`);
      expect(stored?.lastRunError).toMatch(/^Your message didn't run/);
      expect(JSON.stringify(messages)).toContain(recovery);
    }
    if (failureKind === "policy") {
      expect(stored?.lastRunError).toBe(policyMessage);
      expect(JSON.stringify(messages)).toContain(policyMessage);
      expect(JSON.stringify(messages)).not.toContain("private-policy-diagnostic");
      expectLastError(broadcast, policyMessage);
    }
    if (restartSafe) {
      expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBe(runId);
      const terminal = {
        ...terminalTarget,
        admittedSessionId: target.sessionId,
        clientRunId: runId,
        startedAt: 1_000,
        error: "Late duplicate rejection",
        status: "failed" as const,
        retryable: false,
      };
      expect(await terminalizeRestartSafeChatAdmission(terminal)).toBe(true);
      expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(await terminalizeRestartSafeChatAdmission(terminal)).toBe(false);
      expect(
        (await loadTranscriptEvents(target)).filter(
          (entry) => isRecord(entry) && entry.type === "custom_message",
        ),
      ).toHaveLength(1);
    }
  });
});

it("settles restart-safe rejection even when its notice write fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const target = {
      sessionKey: "agent:main:main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: "settled-session",
      updatedAt: 1_000,
      restartRecoveryDeliveryRunId: "settled-run",
    });
    using _ = vi
      .spyOn(sessionRunError, "recordGatewaySessionRunFailure")
      .mockRejectedValueOnce(new Error("notice write failed"));
    const terminalTarget = await captureTerminalTarget(target);
    expect(
      await terminalizeRestartSafeChatAdmission({
        ...terminalTarget,
        admittedSessionId: "settled-session",
        clientRunId: "settled-run",
        startedAt: 1_000,
        status: "failed",
        error: "Worker unavailable",
        retryable: false,
      }),
    ).toBe(true);
    expect(loadSessionEntry(target)).toMatchObject({
      status: "failed",
      lastRunId: "settled-run",
    });
    expect(loadSessionEntry(target)?.restartRecoveryDeliveryRunId).toBeUndefined();
  });
});

it("preserves queued refresh after dispatch failure", async () => {
  const context = createContext();
  const { broadcast, dedupe, removeChatRun } = context;
  const warn = context.logGateway.warn;
  const cleanupAdmittedRun = vi.fn();
  const cached = { ts: 1, ok: true, payload: { runId: "run-1", status: "completed" } };
  dedupe.set("chat:run-1", cached);
  const lifecycle = createLifecycle({
    admission: {
      sessionBinding: createSessionBinding("run-1"),
      cleanupAdmittedRun,
    },
    context,
    isQueuedFollowupEnqueued: () => true,
    session: { backingSessionId: undefined, clientRunId: "run-1" },
    userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
  });

  await lifecycle.handleError(new Error("late failure"));
  await lifecycle.finalize();

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("dispatch failed after followup queue admission"),
  );
  expect(dedupe.get("chat:run-1")).toBe(cached);
  expect(broadcast).not.toHaveBeenCalled();
  expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
  expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "agent:main:main");
});

it.each(["resolves", "rejects"])(
  "preserves an explicitly aborted terminal when its dispatch later %s",
  async (settlement) => {
    const runId = `explicit-abort-before-dispatch-${settlement}`;
    const { sessionKey, chatAbortControllers, context, registration } = registerRun(runId);
    const { broadcast, chatRunState, dedupe, removeChatRun } = context;
    const entry = registration.entry;
    const terminalizeRestartSafeAdmission = vi.fn();
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
        return;
      }
      const current = chatAbortControllers.get(runId);
      if (current) {
        current.projectSessionTerminalPending = true;
        current.projectSessionTerminalObservedAt = event.ts;
      }
    });

    try {
      expect(
        abortChatRunById(
          {
            chatAbortControllers,
            chatRunState,
            removeChatRun,
            agentRunSeq: new Map(),
            broadcast,
            nodeSendToSession: vi.fn(),
          },
          { runId, sessionKey },
        ),
      ).toEqual({ aborted: true });

      const lifecycle = createLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: registration.cleanup,
          restartSafeAdmission: {} as never,
        },
        context,
        session: { clientRunId: runId },
        terminalizeRestartSafeAdmission,
      });

      if (settlement === "rejects") {
        await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
      }
      await lifecycle.finalize();

      expect(dedupe.get(`chat:${runId}`)).toMatchObject({
        ok: true,
        payload: { runId, status: "timeout", summary: "aborted" },
      });
      expectNoError(broadcast, runId);
      expect(chatAbortControllers.get(runId)).toBe(entry);
      expect(entry).toMatchObject({
        projectSessionTerminalPending: true,
        registrationCleanupRequested: true,
      });
      expect(terminalizeRestartSafeAdmission).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      registration.cleanup();
    }
  },
);

it.each([false, true])(
  "classifies dispatch authority failure from typed restart=%s",
  async (restart) => {
    const controller = new AbortController();
    controller.abort(
      restart ? createAgentRunRestartAbortError() : new Error("restart interrupted dispatch"),
    );
    const context = createContext();
    const { broadcast, dedupe } = context;
    const lifecycle = createLifecycle({
      admission: { activeRunAbort: createAbort(controller) },
      context,
      session: { clientRunId: "signal-only-rejection" },
    });

    await lifecycle.handleError(new Error("operator source authority is no longer active"));
    await lifecycle.finalize();

    expect(dedupe.get("chat:signal-only-rejection")).toMatchObject({
      ok: restart,
      payload: { runId: "signal-only-rejection", status: restart ? "timeout" : "error" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: "signal-only-rejection",
        state: restart ? "aborted" : "error",
      }),
      { sessionKeys: ["agent:main:main"] },
    );
  },
);

it("preserves the native terminal even when its projection failed", async () => {
  const runId = "agent-owned-terminal";
  const { context, registration } = registerRun(runId);
  markChatAbortTerminalOutcome(registration.entry);
  registration.entry.projectSessionTerminalPersisted = false;
  const terminalEntry = {
    ts: Date.now(),
    ok: true,
    payload: { runId, status: "ok" as const },
  };
  const { broadcast, chatRunState, dedupe } = context;
  dedupe.set(`chat:${runId}`, terminalEntry);
  chatRunState.getOrCreate(runId).buffer = "Native-owned output";
  const lifecycle = createLifecycle({
    admission: { activeRunAbort: registration, cleanupAdmittedRun: registration.cleanup },
    context,
    isAgentRunStarted: () => true,
    session: { clientRunId: runId },
  });

  await lifecycle.handleError(new Error("dispatch rejected after agent terminal"));
  await lifecycle.finalize();

  expect(dedupe.get(`chat:${runId}`)).toBe(terminalEntry);
  expect(chatRunState.runs.get(runId)?.buffer).toBe("Native-owned output");
  expectNoError(broadcast, runId);
});

it("retains non-default global admission through failure persistence", async () => {
  const cfg = retainLegacyDefaultAgentId({ agents: { entries: { main: {}, ops: {} } } }, "main");
  const persistenceEntered = createDeferred();
  const releasePersistence = createDeferred();
  const persistLifecycleEvent = vi
    .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
    .mockImplementation(async () => {
      persistenceEntered.resolve();
      await releasePersistence.promise;
    });
  const sessionBinding: LifecycleParams["admission"]["sessionBinding"] = {
    sessionId: "sess-ops",
    sessionKey: "agent:ops:main",
    agentId: "ops",
    lifecycleGeneration: "test-generation",
  };
  const target = { scope: "/isolated/dispatch-terminal", identities: [sessionBinding.sessionId] };
  const work = await beginSessionWorkAdmission({
    ...target,
    assertAllowed: () => {},
    isSettling: () => sessionBinding.terminalOutcomeObserved === true,
  });
  const cleanupAdmittedRun = vi.fn(work.release);
  const activeRunCleanup = vi.fn();
  const context = {
    ...createContext(),
    broadcast: vi.fn(() => getTerminalSessionWorkAdmissionRelease(target)),
    broadcastToConnIds: vi.fn(),
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
  };
  const { broadcast, dedupe } = context;
  const clientRunId = "failed-ops-global-send";
  const chatAbortControllers = new Map([
    [
      "compat-owner-run",
      {
        controller: new AbortController(),
        sessionId: "sess-main",
        sessionKey: "global",
      },
    ],
  ]);

  try {
    const lifecycle = createLifecycle({
      admission: {
        sessionBinding,
        activeRunAbort: createAbort(undefined, activeRunCleanup),
        cleanupAdmittedRun,
      },
      context: { ...context, chatAbortControllers },
      session: {
        agentId: "ops",
        backingSessionId: "sess-ops",
        cfg,
        clientRunId,
        rawSessionKey: "global",
        sessionKey: "global",
      },
    });

    expect(getTerminalSessionWorkAdmissionRelease(target)).toBe(false);
    await lifecycle.handleError(new Error("dispatch rejected"));
    const finalization = lifecycle.finalize();
    await persistenceEntered.promise;
    expect(dedupe.get(`chat:${clientRunId}`)).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(persistLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "ops",
      event: expect.objectContaining({
        runId: clientRunId,
        sessionId: "sess-ops",
        data: expect.objectContaining({ phase: "error" }),
      }),
    });
    expect(cleanupAdmittedRun).not.toHaveBeenCalled();
    releasePersistence.resolve();
    await finalization;
    expect(dedupe.get(`chat:${clientRunId}`)).toMatchObject({
      ok: false,
      payload: { runId: clientRunId, status: "error" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: clientRunId, state: "error" }),
      expect.anything(),
    );
    await expect(broadcast.mock.results[0]?.value).resolves.toBeUndefined();
    expect(activeRunCleanup).toHaveBeenCalledExactlyOnceWith();
    expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
  } finally {
    releasePersistence.resolve();
    work.release();
    persistLifecycleEvent.mockRestore();
  }
});
