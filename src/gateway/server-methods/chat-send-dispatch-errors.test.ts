import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
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
  beginSessionEffect,
  getTerminalSessionWorkAdmissionRelease,
} from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as sessionRunError from "../../sessions/session-run-error.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../state/agent-database-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { markChatAbortTerminalOutcome } from "../chat-abort-lifecycle-internal.js";
import { abortChatRunById } from "../chat-abort.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { createChatRunState } from "../server-chat-state.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
import { broadcastChatDelta } from "./chat-broadcast.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import {
  createChatSendDispatchErrorLifecycle,
  handleChatSendSetupError,
} from "./chat-send-dispatch-errors.js";
import {
  createActiveRpcSourceForTest,
  registerRpcSourceForTest,
} from "./rpc-source-fixtures.test-support.js";

const policyMessage =
  "OpenCode cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.";

type DispatchOptions = Parameters<typeof createChatSendDispatchErrorLifecycle>[0];
function dispatchLifecycle(
  registration: ReturnType<typeof registerRpcSourceForTest>,
  overrides: Partial<Omit<DispatchOptions, "admission" | "context" | "session">> & {
    admission?: Partial<DispatchOptions["admission"]>;
    context?: Partial<Omit<DispatchOptions["context"], "logGateway">> & {
      logGateway?: Pick<DispatchOptions["context"]["logGateway"], "warn">;
    };
    session?: Partial<DispatchOptions["session"]>;
  } = {},
) {
  const { admission, context, session, ...rest } = overrides;
  const target = expectDefined(registration.entry.input.target, "source target");
  const options: DispatchOptions = {
    admission: {
      activeRunAbort: registration,
      cleanupAdmittedRun: vi.fn(),
      lifecycleGeneration: "test-generation",
      restartSafeAdmission: undefined,
      ...admission,
    },
    context: {
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      chatRunState: createChatRunState(),
      dedupe: new Map(),
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(),
      ...context,
    } as DispatchOptions["context"],
    session: {
      agentId: "main",
      storePath: target.storeScope,
      cfg: {},
      clientRunId: expectDefined(registration.entry.input.protocolRunId, "source run"),
      now: 1,
      rawSessionKey: target.sessionKey,
      sessionKey: target.sessionKey,
      ...session,
    },
    isQueuedFollowupEnqueued: () => false,
    isAgentRunStarted: () => false,
    persistUserTurnTranscript: vi.fn(),
    terminalizeRestartSafeAdmission: vi.fn(),
    userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
    ...rest,
  };
  return { ...createChatSendDispatchErrorLifecycle(options), options };
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

describe("handleChatSendSetupError", () => {
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
  ])(
    "returns %s setup failures to the client retry owner without a terminal broadcast",
    async (error) => {
      const cleanupAdmittedRun = vi.fn();
      const broadcast = vi.fn();
      const respond = vi.fn();
      const dedupe = new Map();
      const terminalizeRestartSafeAdmission = vi.fn();
      const restart = error instanceof GatewayDrainingError;
      const activeRunAbort = registerRpcSourceForTest({
        runId: "setup-projection-retry",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      if (restart) {
        markGatewayRestartDraining();
      }
      const lifecycle = dispatchLifecycle(activeRunAbort, {
        admission: {
          cleanupAdmittedRun,
          restartSafeAdmission: restart ? { requestFingerprint: "restart" } : undefined,
        },
        context: { broadcast, dedupe },
        terminalizeRestartSafeAdmission,
      });
      try {
        await handleChatSendSetupError({
          ...lifecycle.options,
          error,
          respond,
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
      } finally {
        activeRunAbort.cleanup();
      }
    },
  );
});

describe("createChatSendDispatchErrorLifecycle", () => {
  it.each([
    { settlement: "fallback" },
    { settlement: "fallback", stateContention: true },
    { settlement: "fallback", restartFailure: true },
    { settlement: "restart-safe", restartFailure: true },
    { settlement: "restart-safe", stateContention: true },
    { settlement: "restart-safe" },
    { settlement: "fallback", missingProfile: true },
    { settlement: "fallback", policyFailure: true },
    { settlement: "fallback", sessionChanged: true },
  ])(
    "records the rejected input and bounded error through $settlement settlement (missing profile: $missingProfile, policy refusal: $policyFailure, session changed: $sessionChanged)",
    async ({
      settlement,
      missingProfile,
      policyFailure,
      sessionChanged,
      stateContention,
      restartFailure,
    }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "dispatch-failure-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const runId = "dispatch-failure-run";
        const lifecycleGeneration = restartFailure
          ? getAgentEventLifecycleGeneration()
          : "test-generation";
        const restartSafe = settlement === "restart-safe";
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1_000,
          startedAt: 1_000,
          lifecycleRunId: runId,
          ...(restartSafe
            ? {
                restartRecoveryDeliveryRunId: runId,
                restartRecoveryDeliverySourceRunId: runId,
              }
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
        const warn = vi.fn();
        const chatRunState = createChatRunState();
        const broadcast = vi.fn();
        const agentRunSeq = new Map<string, number>();
        rpcSourceTesting.clear();
        broadcastChatDelta({
          context: { chatRunState, broadcast, agentRunSeq, nodeSendToSession: vi.fn() },
          runId,
          sessionKey: target.sessionKey,
          text: "Command instructions",
          isCurrent: () => true,
        });
        const previewGroup = chatRunState.runs.get(runId)?.liveTextGroup;
        const registration = registerRpcSourceForTest({
          runId,
          ...target,
          storeScope: target.storePath,
        });
        const lifecycle = dispatchLifecycle(registration, {
          admission: {
            lifecycleGeneration,
            restartSafeAdmission: restartSafe
              ? { requestFingerprint: "test-fingerprint" }
              : undefined,
          },
          context: {
            agentRunSeq,
            broadcast,
            broadcastToConnIds: vi.fn(),
            chatRunState,
            getSessionEventSubscriberConnIds: () => new Set<string>(),
            logGateway: { warn },
          },
          persistUserTurnTranscript,
          session: {
            now: 1_000,
          },
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

        const failure = restartFailure
          ? new GatewayDrainingError()
          : stateContention
            ? Object.assign(new Error("database is locked"), {
                code: "ERR_SQLITE_ERROR",
                errcode: 5,
              })
            : sessionChanged
              ? new DispatchSessionRefreshRequiredError(
                  new Error(`Session "${target.sessionKey}" changed while starting work. Retry.`),
                )
              : missingProfile
                ? createSelectedAuthProfileUnavailableError({
                    profileId: "openai:removed",
                    provider: "openai",
                    modelId: "fixture-model",
                  })
                : policyFailure
                  ? new AgentHarnessPreflightError("private-policy-diagnostic", {
                      userMessage: policyMessage,
                    })
                  : new Error("Cloud worker unavailable");
        if (restartFailure) {
          markGatewayRestartDraining();
        }
        try {
          await lifecycle.handleError(failure);
          expect(previewGroup?.signal.aborted).toBe(false);
          await lifecycle.finalize();
        } finally {
          if (restartFailure) {
            resetGatewayWorkAdmission();
          }
        }
        expect(broadcast).toHaveBeenLastCalledWith(
          "chat",
          expect.objectContaining(
            restartFailure ? { state: "aborted", stopReason: "restart" } : { state: "error" },
          ),
          {
            liveText: { group: previewGroup?.signal, settle: restartFailure ? undefined : true },
            sessionKeys: [target.sessionKey],
          },
        );
        expect(chatRunState.runs.has(runId)).toBe(false);
        expect(previewGroup?.signal.aborted).toBe(true);

        expect(warn).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toMatchObject({
          status: restartFailure ? "interrupted" : "failed",
          lastRunId: runId,
        });
        const messages = (await loadTranscriptEvents(target)).filter(
          (entry) =>
            isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
        );
        if (restartFailure) {
          expect(messages).toEqual([
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({ role: "user", content: "Please continue." }),
            }),
          ]);
          expect(loadSessionEntry(target)).toMatchObject({ abortedLastRun: true });
          if (restartSafe) {
            expect(loadSessionEntry(target)?.restartRecoveryDeliverySourceRunId).toBe(runId);
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
        if (stateContention) {
          const summary =
            "Your request was interrupted while the server was busy. Check its status before trying again.";
          const terminal = broadcast.mock.calls.at(-1)?.[1];
          expect(terminal).toMatchObject({ errorKind: "state_contention" });
          expect(terminal.errorMessage).toMatch(new RegExp(`^${summary.replaceAll(".", "\\.")}`));
          expect(loadSessionEntry(target)?.lastRunError).toBe(summary);
          expect(messages[1]).toMatchObject({
            content: summary,
            details: { errorKind: "state_contention" },
          });
          const notice = messages[1];
          if (!isRecord(notice)) {
            throw new Error("Expected a recorded failure notice");
          }
          const restored = projectChatDisplayMessages([{ role: "custom", ...notice }]);
          expect(restored[0]).toMatchObject({
            content: summary,
            details: {
              errorKind: "state_contention",
              diagnostic: terminal.errorMessage.split("\n\n")[1],
            },
          });
          expect(restored[0]).not.toHaveProperty("details.error");
          expect(restored[0]).not.toHaveProperty("details.runId");
        }
        if (missingProfile) {
          const recovery = renderFailoverCodeUserCopy("selected_auth_profile_unavailable")!;
          const storedError = loadSessionEntry(target)?.lastRunError;
          expect(storedError).toMatch(/^This saved login isn't available\./u);
          expect(storedError).toContain("run `openclaw configure`.");
          expect(storedError?.length).toBeLessThanOrEqual(160);
          expect(JSON.stringify(messages)).toContain(recovery);
          expect(JSON.stringify(messages)).not.toContain("openai:removed");
          expect(broadcast).toHaveBeenLastCalledWith(
            "chat",
            expect.objectContaining({ errorMessage: recovery }),
            expect.anything(),
          );
        }
        if (sessionChanged) {
          const recovery =
            "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
          expect(broadcast).toHaveBeenLastCalledWith(
            "chat",
            expect.objectContaining({ errorMessage: `${recovery}\n\n${String(failure)}` }),
            expect.anything(),
          );
          expect(loadSessionEntry(target)?.lastRunError).toMatch(/^Your message didn't run/);
          expect(JSON.stringify(messages)).toContain(recovery);
        }
        if (policyFailure) {
          expect(loadSessionEntry(target)?.lastRunError).toBe(policyMessage);
          expect(JSON.stringify(messages)).toContain(policyMessage);
          expect(JSON.stringify(messages)).not.toContain("private-policy-diagnostic");
          expect(broadcast).toHaveBeenLastCalledWith(
            "chat",
            expect.objectContaining({ errorMessage: policyMessage }),
            expect.anything(),
          );
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
    },
  );

  it("keeps restart-safe settlement successful when its notice cannot be written", async () => {
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
      const report = vi
        .spyOn(sessionRunError, "recordGatewaySessionRunFailure")
        .mockRejectedValueOnce(new Error("notice write failed"));
      const terminalTarget = await captureTerminalTarget(target);
      try {
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
      } finally {
        report.mockRestore();
      }
    });
  });

  it("terminalizes an explicitly aborted restart-safe admission exactly once", async () => {
    const runId = "explicit-abort-restart-safe";
    const sessionKey = "agent:main:main";
    const registration = registerRpcSourceForTest({ runId, sessionKey, sessionId: "sess-main" });
    const terminalizeRestartSafeAdmission = vi.fn().mockResolvedValue(false);
    const lifecycle = dispatchLifecycle(registration, {
      admission: { restartSafeAdmission: { requestFingerprint: "abort-fixture" } },
      terminalizeRestartSafeAdmission,
      userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
    });
    const unsubscribe = onAgentRuntimeEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle" && event.data.phase === "end") {
        registration.entry.adapter.projectSessionTerminalPending = true;
        registration.entry.adapter.projectSessionTerminalObservedAt = event.ts;
      }
    });
    try {
      expect(abortChatRunById(lifecycle.options.context, { runId, sessionKey })).toEqual({
        aborted: true,
      });
      await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
      await lifecycle.finalize();
      expect(terminalizeRestartSafeAdmission).toHaveBeenCalledExactlyOnceWith({
        retryable: false,
        status: "killed",
      });
    } finally {
      unsubscribe();
      registration.cleanup();
    }
  });

  it.each([false, true])(
    "classifies dispatch authority failure from typed restart=%s",
    async (restart) => {
      const registration = registerRpcSourceForTest({
        runId: "signal-only-dispatch-rejection",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      registration.controller.abort(
        restart ? createAgentRunRestartAbortError() : new Error("restart interrupted dispatch"),
      );
      const chatRunState = createChatRunState();
      const dedupe = new Map();
      const broadcast = vi.fn();
      const lifecycle = dispatchLifecycle(registration, {
        context: { broadcast, chatRunState, dedupe },
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("operator source authority is no longer active"));
      await lifecycle.finalize();

      expect(dedupe.get("chat:signal-only-dispatch-rejection")).toMatchObject({
        ok: restart,
        payload: { runId: "signal-only-dispatch-rejection", status: restart ? "timeout" : "error" },
      });
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: "signal-only-dispatch-rejection",
          state: restart ? "aborted" : "error",
        }),
        { sessionKeys: ["agent:main:main"] },
      );
    },
  );

  it.each([true, false])(
    "does not overwrite a lifecycle terminal after persistence success=%s",
    async (persisted) => {
      const runId = "agent-owned-terminal-before-dispatch-rejection";
      const sessionKey = "agent:main:main";
      const registration = registerRpcSourceForTest({
        runId,
        sessionId: "sess-main",
        sessionKey,
      });
      if (!registration.entry) {
        throw new Error("expected the chat abort controller to be registered");
      }
      markChatAbortTerminalOutcome(registration.entry);
      registration.entry.adapter.projectSessionTerminalPersisted = persisted;
      const terminalEntry = {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" as const },
      };
      const dedupe = new Map([[`chat:${runId}`, terminalEntry]]);
      const broadcast = vi.fn();
      const chatRunState = createChatRunState();
      chatRunState.getOrCreate(runId).buffer = "Native-owned output";
      const lifecycle = dispatchLifecycle(registration, {
        admission: {
          cleanupAdmittedRun: registration.cleanup,
        },
        context: { broadcast, chatRunState, dedupe },
        isAgentRunStarted: () => true,
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("dispatch rejected after agent terminal"));
      await lifecycle.finalize();

      expect(dedupe.get(`chat:${runId}`)).toBe(terminalEntry);
      expect(chatRunState.runs.get(runId)?.buffer).toBe("Native-owned output");
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error" }),
        expect.anything(),
      );
    },
  );

  it("keeps a failed non-default global send admitted through lifecycle persistence", async () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          entries: { main: {}, ops: {} },
        },
      },
      "main",
    );
    const persistenceEntered = createDeferred();
    const releasePersistence = createDeferred();
    const persistLifecycleEvent = vi
      .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
      .mockImplementation(async () => {
        persistenceEntered.resolve();
        await releasePersistence.promise;
      });
    const clientRunId = "failed-ops-global-send";
    const target = {
      scope: "/isolated/dispatch-terminal",
      identities: ["agent:ops:main", "sess-ops"],
    };
    const registration = registerRpcSourceForTest({
      runId: clientRunId,
      sessionId: "sess-ops",
      sessionKey: "agent:ops:main",
      agentId: "ops",
      storeScope: target.scope,
    });
    if (!registration.entry) {
      throw new Error("Expected the failed send's controller source");
    }
    const source = registration.entry;
    const work = await beginSessionEffect({
      ...target,
      sourceInput: source.input,
      assertAllowed: () => {},
      isSettling: () => source.adapter.terminalOutcomeObserved === true,
    });
    const cleanupAdmittedRun = vi.fn(work.release);
    const activeRunCleanup = vi.fn(registration.cleanup);
    const broadcast = vi.fn(() => getTerminalSessionWorkAdmissionRelease(target));
    const dedupe = new Map();
    rpcSourceTesting.set(
      "compat-owner-run",
      await createActiveRpcSourceForTest(
        {},
        { sessionId: "sess-main", sessionKey: "global", storeScope: target.scope },
      ),
    );

    try {
      const lifecycle = dispatchLifecycle(registration, {
        admission: {
          activeRunAbort: { ...registration, cleanup: activeRunCleanup },
          cleanupAdmittedRun,
        },
        context: {
          broadcast,
          broadcastToConnIds: vi.fn(),
          dedupe,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
        },
        session: {
          agentId: "ops",
          cfg,
          rawSessionKey: "global",
          sessionKey: "global",
        },
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
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
      registration.cleanup();
      persistLifecycleEvent.mockRestore();
    }
  });
});
