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
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { getAgentEventLifecycleGeneration, onAgentRuntimeEvent } from "../../infra/agent-events.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
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
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../state/agent-database-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { markChatAbortTerminalOutcome } from "../chat-abort-lifecycle-internal.js";
import { abortChatRunById } from "../chat-abort.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { createChatRunState } from "../server-chat-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as sessionLifecycleState from "../session-lifecycle-state.js";
import { broadcastChatDelta } from "./chat-broadcast.js";
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

describe("handleChatSendSetupError", () => {
  it.each([false, true])("preserves an uncertain setup outcome (cleanup: %s)", async (cleanup) => {
    const primary = new SqliteWorkerError("PRIVATE_WRITE_DETAIL", "outcome-unknown");
    const error = cleanup
      ? new AggregateError([primary, new Error("PRIVATE_CLEANUP_DETAIL")], "PRIVATE_AGGREGATE", {
          cause: primary,
        })
      : primary;
    const respond = vi.fn();
    const broadcast = vi.fn();
    const dedupe = new Map();
    const runId = "setup-outcome-unknown";
    const activeRunAbort = registerRpcSourceForTest({
      runId,
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    try {
      await handleChatSendSetupError({
        admission: {
          activeRunAbort,
          cleanupAdmittedRun: vi.fn(),
          lifecycleGeneration: "test-generation",
        },
        context: createDirectChatContext({ broadcast, dedupe, getRuntimeConfig: () => ({}) }),
        error,
        respond,
        session: { agentId: "main", clientRunId: runId, sessionKey: "agent:main:main" },
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload, refusal] = respond.mock.calls[0]!;
      expect(ok).toBe(false);
      expect(refusal).toMatchObject({ code: "UNAVAILABLE", retryable: false });
      expect(refusal.message).toMatch(/confirm|saved/i);
      expect(refusal.message).toMatch(/check|reopen|retry/i);
      expect(refusal.message).not.toContain("PRIVATE_");
      expect(payload).toMatchObject({ runId, status: "error", summary: refusal.message });
      expect(dedupe.get(`chat:${runId}`)).toMatchObject({ ok: false, error: refusal, payload });
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error", errorMessage: refusal.message }),
        expect.anything(),
      );
    } finally {
      activeRunAbort.cleanup();
    }
  });

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

      try {
        await handleChatSendSetupError({
          admission: {
            activeRunAbort,
            cleanupAdmittedRun,
            lifecycleGeneration: "test-generation",
          },
          context: {
            agentRunSeq: new Map(),
            broadcast,
            chatRunState: createChatRunState(),
            dedupe,
            logGateway: { warn: vi.fn() },
            nodeSendToSession: vi.fn(),
            removeChatRun: vi.fn(),
          } as never,
          error,
          respond,
          session: {
            agentId: "main",
            clientRunId: "setup-projection-retry",
            sessionKey: "agent:main:main",
          },
        }).finally(() => {
          if (restart) {
            resetGatewayWorkAdmission();
          }
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
    { missingProfile: false, policyFailure: false, sessionChanged: false },
    { unstarted: true },
    { stateContention: true },
    { restartFailure: true },
    { missingProfile: true, policyFailure: false, sessionChanged: false },
    { missingProfile: false, policyFailure: true, sessionChanged: false },
    { missingProfile: false, policyFailure: false, sessionChanged: true },
  ])(
    "records the rejected input and bounded error (missing profile: $missingProfile, policy refusal: $policyFailure, session changed: $sessionChanged, unstarted: $unstarted)",
    async ({
      missingProfile,
      policyFailure,
      sessionChanged,
      stateContention,
      restartFailure,
      unstarted,
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
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1_000,
          startedAt: 1_000,
          ...(unstarted ? {} : { lifecycleRunId: runId }),
        });
        let userPersisted = false;
        const persistUserTurnTranscript = async () => {
          await appendTranscriptMessage(target, {
            message: { role: "user", content: "Please continue." },
          });
          userPersisted = true;
        };
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
        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            activeRunAbort: registerRpcSourceForTest({
              runId,
              ...target,
              storeScope: target.storePath,
            }),
            cleanupAdmittedRun: vi.fn(),
            lifecycleGeneration,
          },
          context: {
            agentRunSeq,
            broadcast,
            broadcastToConnIds: vi.fn(),
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
            storePath: target.storePath,
            cfg: {},
            clientRunId: runId,
            now: 1_000,
            rawSessionKey: target.sessionKey,
            sessionKey: target.sessionKey,
          },
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
          status: restartFailure ? "killed" : "failed",
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
      });
    },
  );

  it.each([false, true])(
    "preserves queued refresh completion after a later dispatch failure (completed=%s)",
    async (completed) => {
      const broadcast = vi.fn();
      const cleanupAdmittedRun = vi.fn();
      const removeChatRun = vi.fn();
      const warn = vi.fn();
      const cached = {
        ts: 1,
        ok: true,
        payload: { runId: "run-1", status: completed ? "completed" : "accepted" },
      };
      const dedupe = new Map([["chat:run-1", cached]]);
      const registration = registerRpcSourceForTest({
        runId: "run-1",
        sessionId: "run-1",
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun,
          lifecycleGeneration: "test-generation",
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
        isAgentRunStarted: () => false,
        persistUserTurnTranscript: vi.fn(),
        session: {
          agentId: "main",
          storePath: expectDefined(registration.entry.input.target, "source target").storeScope,
          cfg: {},
          clientRunId: "run-1",
          now: 1,
          rawSessionKey: "agent:main:main",
          sessionKey: "agent:main:main",
        },
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
    },
  );

  it.each(["resolves", "rejects"])(
    "preserves an explicitly aborted terminal when its dispatch later %s",
    async (settlement) => {
      const runId = `explicit-abort-before-dispatch-${settlement}`;
      const sessionKey = "agent:main:main";
      rpcSourceTesting.clear();
      const chatRunState = createChatRunState();
      const registration = registerRpcSourceForTest({
        runId,
        sessionId: "sess-main",
        sessionKey,
      });
      if (!registration.registered) {
        throw new Error("expected the chat abort controller to be registered");
      }
      const removeChatRun = vi.fn();
      const broadcast = vi.fn();
      const dedupe = new Map();
      const warn = vi.fn();
      const unsubscribe = onAgentRuntimeEvent((event) => {
        if (event.runId !== runId || event.stream !== "lifecycle" || event.data.phase !== "end") {
          return;
        }
        const current = rpcSourceTesting.get(runId);
        if (current) {
          current.adapter.projectSessionTerminalPending = true;
          current.adapter.projectSessionTerminalObservedAt = event.ts;
        }
      });

      try {
        expect(
          abortChatRunById(
            {
              chatRunState,
              removeChatRun,
              agentRunSeq: new Map(),
              broadcast,
              nodeSendToSession: vi.fn(),
            },
            { runId, sessionKey },
          ),
        ).toEqual({ aborted: true });

        const lifecycle = createChatSendDispatchErrorLifecycle({
          admission: {
            activeRunAbort: registration,
            cleanupAdmittedRun: registration.cleanup,
            lifecycleGeneration: "test-generation",
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
            storePath: expectDefined(registration.entry.input.target, "source target").storeScope,
            cfg: {},
            clientRunId: runId,
            now: 1,
            rawSessionKey: sessionKey,
            sessionKey,
          },
          userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
        });

        if (settlement === "rejects") {
          await lifecycle.handleError(new Error("dispatch rejected after explicit abort"));
        }
        await lifecycle.finalize();

        expect(dedupe.get(`chat:${runId}`)).toMatchObject({
          ok: true,
          payload: { runId, status: "timeout", summary: "aborted" },
        });
        expect(broadcast).not.toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "error" }),
          expect.anything(),
        );
        expect(rpcSourceTesting.has(runId)).toBe(false);
      } finally {
        unsubscribe();
        registration.cleanup();
      }
    },
  );

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
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: vi.fn(),
          lifecycleGeneration: "test-generation",
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
          storePath: expectDefined(registration.entry.input.target, "source target").storeScope,
          cfg: {},
          clientRunId: "signal-only-dispatch-rejection",
          now: 1,
          rawSessionKey: "agent:main:main",
          sessionKey: "agent:main:main",
        },
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

  it.each([
    { persisted: true, delegated: false },
    { persisted: false, delegated: false },
    { persisted: true, delegated: true },
  ])(
    "retains native terminal ownership (persistence success=$persisted, delegated error=$delegated)",
    async ({ persisted, delegated }) => {
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
      const terminalPersistence = createDeferred();
      if (delegated) {
        registration.entry.adapter.projectSessionTerminalPersistence =
          terminalPersistence.promise.then(() => {
            registration.entry.adapter.chatErrorDispatchOwned = true;
          });
      }
      const terminalEntry = {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "ok" as const },
      };
      const dedupe = new Map(delegated ? [] : [[`chat:${runId}`, terminalEntry]]);
      const broadcast = vi.fn();
      const chatRunState = createChatRunState();
      chatRunState.getOrCreate(runId).buffer = "Native-owned output";
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: registration,
          cleanupAdmittedRun: registration.cleanup,
          lifecycleGeneration: "test-generation",
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
          storePath: expectDefined(registration.entry.input.target, "source target").storeScope,
          cfg: {},
          clientRunId: runId,
          now: 1,
          rawSessionKey: sessionKey,
          sessionKey,
        },
        userTurnRecorder: { hasPersisted: () => true, isBlocked: () => false },
      });

      const rejected = lifecycle.handleError(new Error("dispatch rejected after agent terminal"));
      if (delegated) {
        expect(dedupe.size).toBe(0);
        expect(broadcast).not.toHaveBeenCalled();
      }
      terminalPersistence.resolve();
      await rejected;
      await lifecycle.finalize();

      expect(chatRunState.runs.get(runId)?.buffer).toBe("Native-owned output");
      if (delegated) {
        expect(dedupe.get(`chat:${runId}`)).toMatchObject({
          ok: false,
          payload: { runId, status: "error" },
        });
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(
          "chat",
          expect.objectContaining({ runId, state: "error" }),
          expect.anything(),
        );
      } else {
        expect(dedupe.get(`chat:${runId}`)).toBe(terminalEntry);
        expect(broadcast).not.toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ runId, state: "error" }),
          expect.anything(),
        );
      }
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
      const lifecycle = createChatSendDispatchErrorLifecycle({
        admission: {
          activeRunAbort: { ...registration, cleanup: activeRunCleanup },
          cleanupAdmittedRun,
          lifecycleGeneration: "test-generation",
        },
        context: {
          agentRunSeq: new Map(),
          broadcast,
          broadcastToConnIds: vi.fn(),
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
          storePath: target.scope,
          cfg,
          clientRunId,
          now: 1,
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
        expectedWriter: {
          allowUnstartedFailure: true,
          runId: clientRunId,
          sessionId: "sess-ops",
          lifecycleRevision: undefined,
        },
        assertCommitAllowed: expect.any(Function),
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
