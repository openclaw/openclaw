import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSelectedAuthProfileUnavailableError } from "../../agents/auth-profiles/selection-error.js";
import { renderFailoverCodeUserCopy } from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { DispatchSessionRefreshRequiredError } from "../../auto-reply/reply/dispatch-session-refresh-error.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
  type AgentEventPayload,
} from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as sessionRunError from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readChatTerminalDedupeEntry,
  refreshChatTerminalDedupeEntry,
  setGatewayDedupeEntry,
} from "../agent-turn/agent-job.js";
import { abortChatRunById, registerChatAbortController } from "../chat-abort.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createAgentEventHandler } from "../server-chat.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
import { broadcastChatDelta, broadcastChatTerminal } from "./chat-broadcast.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";
import {
  createChatSendDispatchErrorLifecycle,
  handleChatSendSetupError,
} from "./chat-send-dispatch-errors.js";

const policyMessage =
  "OpenCode cannot run with this chat's tool restrictions. Choose a different model provider or update the tool settings.";

describe("handleChatSendSetupError", () => {
  it("returns typed projection setup failures to the client retry owner without a terminal broadcast", async () => {
    const cleanupAdmittedRun = vi.fn();
    const clearRun = vi.fn();
    const broadcast = vi.fn();
    const respond = vi.fn();
    const dedupe = new Map();

    await handleChatSendSetupError({
      admission: {
        sessionBinding: {
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          agentId: "main",
          lifecycleGeneration: "test-generation",
        },
        cleanupAdmittedRun,
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState: { clearRun },
        dedupe,
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      error: new SessionTranscriptProjectionUnavailableError("sess-main"),
      respond,
      session: {
        agentId: "main",
        clientRunId: "setup-projection-retry",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ runId: "setup-projection-retry", status: "error" }),
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true, retryAfterMs: 250 }),
      expect.anything(),
    );
    expect(dedupe.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
  });
});

describe("createChatSendDispatchErrorLifecycle", () => {
  it.each([
    { settlement: "fallback", missingProfile: false, policyFailure: false, sessionChanged: false },
    { settlement: "fallback", stateContention: true },
    { settlement: "restart-safe", stateContention: true },
    {
      settlement: "restart-safe",
      missingProfile: false,
      policyFailure: false,
      sessionChanged: false,
    },
    { settlement: "fallback", missingProfile: true, policyFailure: false, sessionChanged: false },
    {
      settlement: "restart-safe",
      missingProfile: true,
      policyFailure: false,
      sessionChanged: false,
    },
    { settlement: "fallback", missingProfile: false, policyFailure: true, sessionChanged: false },
    {
      settlement: "restart-safe",
      missingProfile: false,
      policyFailure: true,
      sessionChanged: false,
    },
    { settlement: "fallback", missingProfile: false, policyFailure: false, sessionChanged: true },
    {
      settlement: "restart-safe",
      missingProfile: false,
      policyFailure: false,
      sessionChanged: true,
    },
  ])(
    "records the rejected input and bounded error through $settlement settlement (missing profile: $missingProfile, policy refusal: $policyFailure, session changed: $sessionChanged)",
    async ({ settlement, missingProfile, policyFailure, sessionChanged, stateContention }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "dispatch-failure-session",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const runId = "dispatch-failure-run";
        const restartSafe = settlement === "restart-safe";
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1_000,
          startedAt: 1_000,
          lifecycleRunId: runId,
          status: "running",
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
        const warn = vi.fn();
        const chatRunState = createChatRunState();
        const broadcast = vi.fn();
        const agentRunSeq = new Map<string, number>();
        broadcastChatDelta({
          context: { chatRunState, broadcast, agentRunSeq, nodeSendToSession: vi.fn() },
          runId,
          sessionKey: target.sessionKey,
          text: "Command instructions",
          isCurrent: () => true,
        });
        const previewGroup = chatRunState.runs.get(runId)?.liveTextGroup;
        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            sessionBinding: {
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              agentId: target.agentId,
              lifecycleGeneration: "test-generation",
            },
            activeRunAbort: {
              cleanup: vi.fn(),
              controller: new AbortController(),
              entry: undefined,
              registered: true,
            } as never,
            cleanupAdmittedRun: vi.fn(),
            lifecycleGeneration: "test-generation",
            restartSafeAdmission: restartSafe
              ? { requestFingerprint: "test-fingerprint" }
              : undefined,
          },
          context: {
            agentRunSeq,
            broadcast,
            broadcastToConnIds: vi.fn(),
            chatAbortControllers: new Map(),
            chatRunState,
            dedupe: new Map(),
            getRuntimeConfig: () => ({}),
            getSessionEventSubscriberConnIds: () => new Set<string>(),
            logGateway: { warn },
            nodeSendToSession: vi.fn(),
            removeChatRun: vi.fn(),
          } as never,
          isQueuedFollowupEnqueued: () => false,
          isAgentRunStarted: () => false,
          persistUserTurnTranscript,
          session: {
            agentId: target.agentId,
            backingSessionId: target.sessionId,
            cfg: {},
            clientRunId: runId,
            now: 1_000,
            rawSessionKey: target.sessionKey,
            sessionKey: target.sessionKey,
          },
          terminalizeRestartSafeAdmission: (terminal) =>
            terminalizeRestartSafeChatAdmission({
              ...terminal,
              ...target,
              admittedSessionId: target.sessionId,
              clientRunId: runId,
              startedAt: 1_000,
            }),
          userTurnRecorder: { hasPersisted: () => userPersisted, isBlocked: () => false },
        });

        const failure = stateContention
          ? Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })
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
        await lifecycle.handleError(failure);
        expect(previewGroup?.signal.aborted).toBe(false);
        await lifecycle.finalize();
        expect(broadcast).toHaveBeenLastCalledWith(
          "chat",
          expect.objectContaining({ state: "error" }),
          {
            liveText: { group: previewGroup?.signal, settle: true },
            sessionKeys: [target.sessionKey],
          },
        );
        expect(chatRunState.runs.has(runId)).toBe(false);
        expect(previewGroup?.signal.aborted).toBe(true);

        expect(warn).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)).toMatchObject({ status: "failed", lastRunId: runId });
        const messages = (await loadTranscriptEvents(target)).filter(
          (entry) =>
            isRecord(entry) && (entry.type === "message" || entry.type === "custom_message"),
        );
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
          expect(storedError).toMatch(/^The selected auth profile is unavailable/u);
          expect(storedError).toContain("`openclaw configure`, then retry.");
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
            ...target,
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
      try {
        expect(
          await terminalizeRestartSafeChatAdmission({
            ...target,
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

  it.each([false, true])(
    "preserves queued refresh completion after a later dispatch failure (completed=%s)",
    async (completed) => {
      const broadcast = vi.fn();
      const cleanupAdmittedRun = vi.fn();
      const removeChatRun = vi.fn();
      const warn = vi.fn();
      const dedupe = new Map();
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          sessionBinding: {
            sessionId: "run-1",
            sessionKey: "agent:main:main",
            agentId: "main",
            lifecycleGeneration: "test-generation",
          },
          activeRunAbort: {
            cleanup: vi.fn(),
            controller: new AbortController(),
            entry: undefined,
            registered: true,
          } as never,
          cleanupAdmittedRun,
          lifecycleGeneration: "test-generation",
          restartSafeAdmission: undefined,
        },
        context: {
          agentRunSeq: new Map(),
          broadcast,
          chatRunState: createChatRunState(),
          dedupe,
          getRuntimeConfig: () => ({}),
          logGateway: { warn },
          nodeSendToSession: vi.fn(),
          removeChatRun,
        } as never,
        isQueuedFollowupEnqueued: () => true,
        isQueuedFollowupCompleted: () => completed,
        isAgentRunStarted: () => false,
        persistUserTurnTranscript: vi.fn(),
        session: {
          agentId: "main",
          backingSessionId: undefined,
          cfg: {},
          clientRunId: "run-1",
          now: 1,
          rawSessionKey: "agent:main:main",
          sessionKey: "agent:main:main",
        },
        terminalizeRestartSafeAdmission: vi.fn(),
        userTurnRecorder: { hasPersisted: () => false, isBlocked: () => false },
      });

      await lifecycle.handleError(new Error("late failure"));
      await lifecycle.finalize();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("dispatch failed after followup queue admission"),
      );
      expect(dedupe.get("chat:run-1")).toMatchObject({
        ok: true,
        payload: { runId: "run-1", status: completed ? "completed" : "ok" },
      });
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "run-1", state: "final" }),
        { sessionKeys: ["agent:main:main"] },
      );
      expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
      expect(removeChatRun).toHaveBeenCalledWith("run-1", "run-1", "agent:main:main");
    },
  );

  it.each([
    { settlement: "resolves", routing: "visible" },
    { settlement: "rejects", routing: "visible" },
    ...(["visible", "private", "subscriber", "replacement"] as const).map((routing) => ({
      settlement: "cleanup rejects",
      routing,
    })),
  ])(
    "preserves an explicitly aborted terminal when dispatch $settlement ($routing)",
    async ({ settlement, routing }) => {
      const runId = `explicit-abort-before-dispatch-${settlement}-${routing}`;
      const sessionKey = "agent:main:main";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const chatAbortControllers = new Map();
      const chatRunState = createChatRunState();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId: "sess-main",
        sessionKey,
        agentId: "main",
        lifecycleGeneration,
        timeoutMs: 60_000,
      });
      if (!registration.registered) {
        throw new Error("expected the chat abort controller to be registered");
      }
      const entry = registration.entry;
      const cleanupError =
        settlement === "cleanup rejects" ? new CommandProcessCleanupError() : undefined;
      if (cleanupError) {
        entry.toolErrorSummary = "Earlier provider diagnostic";
      }
      const persist = cleanupError
        ? vi.spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent").mockResolvedValue()
        : undefined;
      const removeChatRun = vi.fn();
      const broadcast = vi.fn();
      const dedupe = new Map();
      const warn = vi.fn();
      const terminalizeRestartSafeAdmission = vi.fn();
      const broadcastToConnIds = vi.fn();
      const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
      sessionMessageSubscribers.subscribe("cleanup-reader", sessionKey);
      if (cleanupError) {
        registerAgentRunContext(runId, {
          sessionId: "sess-main",
          sessionKey,
          agentId: "main",
          lifecycleGeneration,
          completionSource: "reply-dispatch",
          isControlUiVisible: routing === "visible",
          projectSessionMessages: routing !== "private",
        });
      }
      const cleanupEvents: AgentEventPayload[] = [];
      const chatCalls = () => broadcast.mock.calls.filter(([event]) => event === "chat");
      const handler = cleanupError
        ? createAgentEventHandler({
            broadcast,
            broadcastToConnIds,
            nodeSendToSession: vi.fn(),
            nodeHasSessionSubscribers: () => false,
            agentRunSeq: new Map(),
            chatRunState,
            resolveSessionKeyForRun: () => sessionKey,
            clearAgentRunContext: vi.fn(),
            toolEventRecipients: chatRunState.toolEventRecipients,
            sessionEventSubscribers: createSessionEventSubscriberRegistry(),
            sessionMessageSubscribers,
            loadGatewaySessionLifecycleSnapshotForEvent: () => ({
              row: {
                key: sessionKey,
                kind: "direct",
                sessionId: "sess-main",
                updatedAt: 200,
                lastRunId: runId,
              },
            }),
            persistGatewaySessionLifecycleEventForEvent:
              sessionLifecycleState.persistGatewaySessionLifecycleEvent,
            hasChatTerminalReplay: (ownerRunId, session) =>
              readChatTerminalDedupeEntry({ dedupe, runId: ownerRunId, session }) !== undefined,
            refreshChatTerminalReplay: (ownerRunId, session) =>
              refreshChatTerminalDedupeEntry({ dedupe, runId: ownerRunId, session }),
          })
        : undefined;
      const unsubscribe = onAgentRuntimeEvent((event) => {
        if (event.runId === runId) {
          if (event.data.cleanupError) {
            cleanupEvents.push(event);
          }
          handler?.(event);
        }
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
        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            sessionBinding: {
              sessionId: "sess-main",
              sessionKey: "agent:main:main",
              agentId: "main",
              lifecycleGeneration,
            },
            activeRunAbort: registration,
            cleanupAdmittedRun: registration.cleanup,
            lifecycleGeneration,
            restartSafeAdmission: {} as never,
          },
          context: {
            agentRunSeq: new Map(),
            broadcast,
            chatRunState,
            dedupe,
            getRuntimeConfig: () => ({}),
            logGateway: { warn },
            nodeSendToSession: vi.fn(),
            removeChatRun,
          } as never,
          isQueuedFollowupEnqueued: () => false,
          isAgentRunStarted: () => false,
          persistUserTurnTranscript: vi.fn(),
          session: {
            agentId: "main",
            backingSessionId: "sess-main",
            cfg: {},
            clientRunId: runId,
            now: 1,
            rawSessionKey: sessionKey,
            sessionKey,
          },
          terminalizeRestartSafeAdmission,
          userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
        });

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
        if (cleanupError) {
          clearAgentRunContext(runId);
          if (routing === "replacement") {
            registerAgentRunContext(runId, {
              sessionId: "successor-session",
              sessionKey,
              agentId: "main",
              lifecycleGeneration,
            });
          }
        }

        if (settlement === "rejects") {
          await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
        } else if (cleanupError) {
          // Stop acknowledges before its producer's joined retirement rejects.
          expect(chatCalls()).toHaveLength(1);
          expect(chatCalls()[0]?.[1]).toMatchObject({ state: "aborted", seq: 1 });
          const retirement = createDeferred();
          const pending = retirement.promise.catch(lifecycle.handleError);
          retirement.reject(new Error("Native retirement failed", { cause: cleanupError }));
          await pending;
          // The real canonical event already owns this fact; the outer catch
          // must not emit a second cleanup event on repeated observation.
          await lifecycle.handleError(cleanupError);
        }
        await lifecycle.finalize();

        expect(dedupe.get(`chat:${runId}`)).toMatchObject({
          ok: !cleanupError || routing === "replacement",
          payload: {
            runId,
            status: "timeout",
            summary:
              cleanupError && routing !== "replacement"
                ? expect.stringContaining(cleanupError.message)
                : "aborted",
          },
        });
        if (cleanupError) {
          expect(cleanupEvents).toHaveLength(routing === "replacement" ? 0 : 1);
          const lateChats =
            routing === "subscriber"
              ? broadcastToConnIds.mock.calls.filter(([event]) => event === "chat")
              : chatCalls().slice(1);
          if (routing === "private" || routing === "replacement") {
            expect(lateChats).toEqual([]);
          } else {
            expect(lateChats).toHaveLength(1);
            expect(lateChats[0]?.[1]).toMatchObject({
              state: "aborted",
              seq: 2,
              stopReason: "rpc",
              errorMessage: expect.stringContaining("Earlier provider diagnostic"),
            });
            expect(lateChats[0]?.[1].errorMessage).toContain(cleanupError.message);
          }
          if (routing !== "visible") {
            expect(chatCalls()).toHaveLength(1);
          }
          if (routing !== "replacement") {
            expect(cleanupEvents[0]).toMatchObject({
              controlUiVisible: routing === "visible",
              projectSessionMessages: routing !== "private",
              sessionId: "sess-main",
            });
            expect(persist).toHaveBeenCalledWith(
              expect.objectContaining({
                event: expect.objectContaining({
                  runId,
                  sessionKey,
                  agentId: "main",
                  sessionId: "sess-main",
                  data: expect.objectContaining({ cleanupError: cleanupError.message }),
                }),
              }),
            );
          }
          const replay = dedupe.get(`chat:${runId}`);
          await lifecycle.finalize();
          expect(chatCalls()).toHaveLength(routing === "visible" ? 2 : 1);
          expect(dedupe.get(`chat:${runId}`)).toBe(replay);
        }
        expect(broadcast).not.toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "error" }),
          expect.anything(),
        );
        expect(chatAbortControllers.get(runId)).toBe(entry);
        expect(entry).toMatchObject({
          projectSessionTerminalPending: true,
          registrationCleanupRequested: true,
        });
        expect(terminalizeRestartSafeAdmission).not.toHaveBeenCalled();
      } finally {
        handler?.dispose();
        persist?.mockRestore();
        unsubscribe();
        registration.cleanup();
        clearAgentRunContext(runId);
      }
    },
  );

  it.each(
    (["rpc", "restart", "timeout"] as const).flatMap((stopReason) =>
      [false, true].map((published) => ({ stopReason, published })),
    ),
  )(
    "publishes only an owed cleanup terminal ($stopReason, published=$published)",
    async ({ stopReason, published }) => {
      const runId = "cleanup-first-publication-" + stopReason + "-" + published;
      const session = {
        sessionId: "cleanup-first-publication-session",
        sessionKey: "agent:main:main",
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      const chatRunState = createChatRunState();
      const dedupe = new Map();
      const broadcast = vi.fn();
      const context = {
        agentRunSeq: new Map<string, number>(),
        broadcast,
        chatAbortControllers: new Map(),
        chatRunState,
        dedupe,
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      };
      setGatewayDedupeEntry({
        dedupe,
        key: "chat:" + runId,
        session,
        entry: { ts: 50, ok: true, payload: { runId, status: "accepted" } },
      });
      registerAgentRunContext(runId, { ...session, completionSource: "reply-dispatch" });
      emitAgentEvent({
        runId,
        ...session,
        stream: "lifecycle",
        data: {
          phase: "end",
          aborted: true,
          stopReason,
          ...(stopReason === "timeout" ? { timeoutPhase: "provider", providerStarted: true } : {}),
          startedAt: 100,
          endedAt: 200,
          error: "Earlier provider diagnostic",
          executionSettled: true,
        },
      });
      if (published) {
        setGatewayDedupeEntry({
          dedupe,
          key: "chat:" + runId,
          session,
          entry: {
            ts: 200,
            ok: true,
            payload: {
              runId,
              status: "timeout",
              stopReason,
              startedAt: 100,
              endedAt: 200,
              ...(stopReason === "timeout"
                ? { timeoutPhase: "provider", providerStarted: true }
                : {}),
            },
          },
        });
        broadcastChatTerminal({
          context,
          runId,
          sessionKey: session.sessionKey,
          stopReason,
          ...(stopReason === "timeout"
            ? { state: "error", errorKind: "timeout" }
            : { state: "aborted" }),
        });
        broadcast.mockClear();
      }
      const persist = vi
        .spyOn(sessionLifecycleState, "persistGatewaySessionLifecycleEvent")
        .mockResolvedValue();
      try {
        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            sessionBinding: session,
            activeRunAbort: {
              cleanup: vi.fn(),
              controller: new AbortController(),
              entry: undefined,
              registered: true,
            } as never,
            cleanupAdmittedRun: vi.fn(),
            lifecycleGeneration: session.lifecycleGeneration,
            restartSafeAdmission: undefined,
          },
          context: context as never,
          isQueuedFollowupEnqueued: () => false,
          isAgentRunStarted: () => true,
          isReplyDispatchRun: () => true,
          persistUserTurnTranscript: vi.fn(),
          session: {
            ...session,
            backingSessionId: session.sessionId,
            cfg: {},
            clientRunId: runId,
            now: 100,
            rawSessionKey: session.sessionKey,
          },
          terminalizeRestartSafeAdmission: vi.fn(),
          userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
        });
        const cleanup = new CommandProcessCleanupError();
        await lifecycle.handleError(cleanup);
        await lifecycle.finalize();
        expect(context.logGateway.warn).not.toHaveBeenCalled();
        expect(dedupe.get("chat:" + runId)).toMatchObject({
          ok: false,
          payload: {
            status: "timeout",
            stopReason,
            startedAt: 100,
            endedAt: 200,
            summary: expect.stringContaining(cleanup.message),
          },
        });
        expect(dedupe.get("chat:" + runId)?.error?.message).toContain(
          "Earlier provider diagnostic",
        );
        if (published) {
          expect(broadcast).not.toHaveBeenCalled();
          expect(dedupe.get("chat:" + runId)?.ts).toBe(200);
        } else {
          expect(broadcast).toHaveBeenCalledOnce();
          expect(broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              state: stopReason === "timeout" ? "error" : "aborted",
              stopReason,
              errorMessage: expect.stringContaining(cleanup.message),
              ...(stopReason === "timeout" ? { errorKind: "timeout" } : {}),
            }),
            { sessionKeys: [session.sessionKey] },
          );
        }
      } finally {
        persist.mockRestore();
        clearAgentRunContext(runId);
      }
    },
  );

  it("keeps a signal-only dispatch rejection as an error without an explicit abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("restart interrupted dispatch"));
    const chatRunState = createChatRunState();
    const dedupe = new Map();
    const broadcast = vi.fn();
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        sessionBinding: {
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          agentId: "main",
          lifecycleGeneration: "test-generation",
        },
        activeRunAbort: {
          cleanup: vi.fn(),
          controller,
          entry: undefined,
          registered: true,
        } as never,
        cleanupAdmittedRun: vi.fn(),
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState,
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      isQueuedFollowupEnqueued: () => false,
      isAgentRunStarted: () => false,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: "sess-main",
        cfg: {},
        clientRunId: "signal-only-dispatch-rejection",
        now: 1,
        rawSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
      },
      terminalizeRestartSafeAdmission: vi.fn(),
      userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
    });

    await lifecycle.handleError(new Error("dispatch rejected after restart"));
    await lifecycle.finalize();

    expect(dedupe.get("chat:signal-only-dispatch-rejection")).toMatchObject({
      ok: false,
      payload: { runId: "signal-only-dispatch-rejection", status: "error" },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ runId: "signal-only-dispatch-rejection", state: "error" }),
      { sessionKeys: ["agent:main:main"] },
    );
  });

  it("does not overwrite a terminal already owned by the agent lifecycle", async () => {
    const runId = "agent-owned-terminal-before-dispatch-rejection";
    const sessionKey = "agent:main:main";
    const chatAbortControllers = new Map();
    const registration = registerChatAbortController({
      chatAbortControllers,
      runId,
      sessionId: "sess-main",
      sessionKey,
      timeoutMs: 60_000,
    });
    if (!registration.entry) {
      throw new Error("expected the chat abort controller to be registered");
    }
    registration.entry.projectSessionTerminalPersisted = true;
    const terminalEntry = {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok" as const },
    };
    const dedupe = new Map([[`chat:${runId}`, terminalEntry]]);
    const broadcast = vi.fn();
    const chatRunState = createChatRunState();
    chatRunState.getOrCreate(runId).buffer = "Native-owned output";
    const lifecycle = createChatSendDispatchErrorLifecycle({
      admission: {
        sessionBinding: {
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          agentId: "main",
          lifecycleGeneration: "test-generation",
        },
        activeRunAbort: registration,
        cleanupAdmittedRun: registration.cleanup,
        lifecycleGeneration: "test-generation",
        restartSafeAdmission: undefined,
      },
      context: {
        agentRunSeq: new Map(),
        broadcast,
        chatRunState,
        dedupe,
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      } as never,
      isQueuedFollowupEnqueued: () => false,
      isAgentRunStarted: () => true,
      persistUserTurnTranscript: vi.fn(),
      session: {
        agentId: "main",
        backingSessionId: "sess-main",
        cfg: {},
        clientRunId: runId,
        now: 1,
        rawSessionKey: sessionKey,
        sessionKey,
      },
      terminalizeRestartSafeAdmission: vi.fn(),
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
  });

  it("keeps a failed non-default global send admitted through lifecycle persistence", async () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          list: [{ id: "main" }, { id: "ops" }],
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
    const cleanupAdmittedRun = vi.fn();
    const activeRunCleanup = vi.fn();
    const broadcast = vi.fn();
    const dedupe = new Map();
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
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          sessionBinding: {
            sessionId: "sess-ops",
            sessionKey: "agent:ops:main",
            agentId: "ops",
            lifecycleGeneration: "test-generation",
          },
          activeRunAbort: {
            cleanup: activeRunCleanup,
            controller: new AbortController(),
            entry: undefined,
            registered: true,
          } as never,
          cleanupAdmittedRun,
          lifecycleGeneration: "test-generation",
          restartSafeAdmission: undefined,
        },
        context: {
          agentRunSeq: new Map(),
          broadcast,
          broadcastToConnIds: vi.fn(),
          chatAbortControllers,
          chatRunState: createChatRunState(),
          dedupe,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
          logGateway: { warn: vi.fn() },
          nodeSendToSession: vi.fn(),
          removeChatRun: vi.fn(),
        } as never,
        isQueuedFollowupEnqueued: () => false,
        isAgentRunStarted: () => false,
        persistUserTurnTranscript: vi.fn(),
        session: {
          agentId: "ops",
          backingSessionId: "sess-ops",
          cfg,
          clientRunId,
          now: 1,
          rawSessionKey: "global",
          sessionKey: "global",
        },
        terminalizeRestartSafeAdmission: vi.fn(),
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

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
          sessionKey: "agent:ops:main",
          agentId: "ops",
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
      expect(activeRunCleanup).toHaveBeenCalledExactlyOnceWith();
      expect(cleanupAdmittedRun).toHaveBeenCalledOnce();
    } finally {
      releasePersistence.resolve();
      persistLifecycleEvent.mockRestore();
    }
  });
});
