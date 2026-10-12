import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  replaceSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { QuestionManager } from "../../gateway/question-manager.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { createQuestionHandlers } from "../../gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../../gateway/server-methods/secrets.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "../embedded-agent-runner/runs.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

registerAgentSessionLoopTestLifecycle();

describe("sessions_send direct queue source authority", () => {
  it.each([
    "live",
    "revoked",
    "unscoped",
    "send-revoked",
    "send-live",
    "peer-revoked",
    "peer-live",
    "ask-revoked",
  ] as const)(
    "checks the %s source at the real final enqueue and preserves accepted input",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const crossAgent = source.startsWith("send-");
        const peerPolicy = source.startsWith("peer-");
        const asks = peerPolicy || source === "ask-revoked";
        const rejected =
          source === "revoked" ||
          source === "send-revoked" ||
          source === "peer-revoked" ||
          source === "ask-revoked" ||
          source === "unscoped";
        const targetAgentId = crossAgent ? "worker" : "main";
        const cfg = {
          agents: {
            ownership: "explicit",
            entries: { main: { tools: { agentToAgent: { send: ["worker"] } } }, worker: {} },
          },
          tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        } satisfies OpenClawConfig;
        setRuntimeConfigSnapshot(cfg);
        setActivePluginRegistry(createSessionConversationTestRegistry());
        const requesterSessionKey = "agent:main:dashboard:queue-source";
        const sessionKey = `agent:${targetAgentId}:cron:queue-target:run:active`;
        const sessionId = "queue-target-session";
        for (const [key, id] of [
          [requesterSessionKey, "queue-source-session"],
          [sessionKey, sessionId],
        ] as const) {
          await replaceSessionEntry(
            { agentId: key === requesterSessionKey ? "main" : targetAgentId, sessionKey: key },
            {
              sessionId: id,
              updatedAt: 1,
              ...(asks && key === sessionKey
                ? {
                    communication: { receive: "ask" },
                    createdActor: { type: "human", source: "profile", id: "recipient" },
                  }
                : {}),
            },
          );
        }
        const target = await resolveSessionTranscriptRuntimeTarget({
          agentId: targetAgentId,
          sessionId,
          sessionKey,
        });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        guardSessionManager(manager);
        const { session } = await createTestSession({ sessionManager: manager });
        const queued = vi.spyOn(session.agent, "admitSteeringMessage");
        const preparation = createDeferredCore();
        const resumePreparation = createDeferredCore();
        const queueMessage = async (
          text: string,
          options?: EmbeddedAgentQueueMessageOptions,
          assertCurrent?: () => void,
        ) => {
          const recorder = options?.userTurnTranscriptRecorder;
          if (!recorder) {
            throw new Error("Expected the real sessions_send transcript recorder");
          }
          const resolveMessage = recorder.resolveMessage.bind(recorder);
          vi.spyOn(recorder, "resolveMessage").mockImplementationOnce(async () => {
            preparation.resolve();
            await resumePreparation.promise;
            return await resolveMessage();
          });
          await steerActiveSessionWithOptionalDeliveryWait(
            session,
            text,
            options,
            sessionKey,
            () => {
              assertCurrent?.();
              return true;
            },
          );
        };
        const handle: EmbeddedAgentQueueHandle = {
          runId: "queue-target-run",
          queueMessage,
          isStreaming: () => true,
          isCompacting: () => false,
          abort: () => {},
          sourceReplyDeliveryMode: "message_tool_only",
          // Exercise the delivery owner's retry without transcript-commit waiting.
          supportsTranscriptCommitWait: false,
          ...(source === "unscoped"
            ? { messageInjection: { isAvailable: () => true, queueMessage } }
            : {
                messageInjectionV2: {
                  version: 2 as const,
                  isAvailable: () => true,
                  queueMessage,
                },
              }),
        };
        setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, targetAgentId);
        const instance = createOperationalRunInstanceRef("queue-source-run");
        const authority = claimAgentRunDelegatedAuthority(instance);
        // Resolution is read-only; the real queue and SQLite transcript perform every effect.
        const callGateway = vi
          .fn()
          .mockImplementation(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
            if (request.method !== "sessions.resolve") {
              throw new Error(`Unexpected Gateway dispatch: ${request.method}`);
            }
            return { key: sessionKey, agentId: targetAgentId };
          });
        const scheduler = createTestGatewayScheduler();
        const questions = new QuestionManager(scheduler);
        const unregisterClosed = registerAgentRunDelegatedAuthorityClosedHandler((closed) =>
          questions.cancelClosedAuthorities(closed.operationalRunInstance),
        );
        const questionRequested = createDeferredCore<string>();
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          questionManager: questions,
          broadcast: (event, payload) => {
            if (event === "question.requested") {
              questionRequested.resolve((payload as { id: string }).id);
            }
          },
        });
        const handlers = createQuestionHandlers(
          questions,
          createSecretStoreWriteService({
            reloadSecrets: async () => ({ warningCount: 0 }),
          }),
          scheduler,
        );
        const answer = async (id: string, client: GatewayClient) => {
          const params = { id, answers: { answers: { communication: ["Allow once"] } } };
          const responses: Parameters<RespondFn>[] = [];
          await handleGatewayRequest({
            req: { type: "req", id: "approval", method: "question.resolve", params },
            client,
            isWebchatConnect: () => false,
            context,
            extraHandlers: handlers,
            respond: (...response) => {
              responses.push(response);
            },
          });
          expect(responses).toHaveLength(1);
          return responses[0]![0];
        };
        const message = "guidance-from-" + source + "-source";
        const send = () =>
          createSessionsSendTool({
            config: cfg,
            agentSessionKey: requesterSessionKey,
            expectedTargetSessionId: sessionId,
            completionOwner: "caller",
            expectedTargetStorePath: target.storePath,
            callGateway,
          }).execute("source-send", { sessionKey, message, timeoutSeconds: 0 });
        const pending =
          source === "unscoped" || crossAgent
            ? send()
            : withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  gatewayContextResolver: () => context,
                  operationalRunInstance: instance,
                  approvalAuthority: authority,
                  receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
                },
                send,
              );
        try {
          if (asks) {
            const questionId = await Promise.race([
              questionRequested.promise,
              pending.then(() => {
                throw new Error("Ask send settled before human approval");
              }),
            ]);
            expect(questions.get(questionId)?.questions[0]?.question).toContain(message);
            const creator = createOperatorClient({
              profileId: "recipient",
              scopes: ["operator.questions", "operator.write"],
            });
            const peer = createOperatorClient({
              profileId: "sender",
              scopes: ["operator.questions", "operator.write"],
            });
            const model = {
              ...createOperatorClient({ profileId: "model", scopes: ["operator.admin"] }),
              internal: { syntheticClient: true as const },
            };
            expect(await answer(questionId, peer)).toBe(false);
            expect(await answer(questionId, model)).toBe(false);
            expect(questions.get(questionId)?.status).toBe("pending");
            expect(queued).not.toHaveBeenCalled();
            expect(manager.buildSessionContext().messages).toEqual([]);
            if (source === "ask-revoked") {
              releaseAgentRunDelegatedAuthority(authority);
            }
            expect(await answer(questionId, creator)).toBe(source !== "ask-revoked");
          }
          await Promise.race([preparation.promise, pending]);
          expect(queued).not.toHaveBeenCalled();
          if (source === "revoked") {
            releaseAgentRunDelegatedAuthority(authority);
          }
          const revokeSend = () =>
            setRuntimeConfigSnapshot({
              ...cfg,
              agents: {
                ...cfg.agents,
                entries: { ...cfg.agents.entries, main: { tools: { agentToAgent: { send: [] } } } },
              },
            });
          if (source === "send-revoked") {
            revokeSend();
          }
          const revokePeer = () =>
            replaceSessionEntry(
              { agentId: targetAgentId, sessionKey },
              { sessionId, updatedAt: 2, communication: { receive: "never" } },
            );
          if (source === "peer-revoked") {
            await revokePeer();
          }
          resumePreparation.resolve();
          const result = await pending;
          if (rejected) {
            expect(result.details).toMatchObject({
              status: source === "ask-revoked" ? "forbidden" : "error",
            });
            expect(JSON.stringify(result)).toContain(
              source === "ask-revoked"
                ? "authority"
                : source === "send-revoked"
                  ? "tools.agentToAgent.send"
                  : source === "unscoped"
                    ? "guarded_injection_unsupported"
                    : "Message injection authority is no longer current",
            );
            expect(queued).not.toHaveBeenCalled();
          } else {
            expect(result.details).toMatchObject({
              status: "accepted",
              targetDisposition: "steered",
            });
            expect(queued).toHaveBeenCalledOnce();
          }
          // Acceptance transfers ownership: closing the sender cannot withdraw accepted guidance.
          releaseAgentRunDelegatedAuthority(authority);
          if (crossAgent) {
            revokeSend();
          }
          if (peerPolicy && !rejected) {
            await revokePeer();
          }
          streamMocks.streamSimple.mockImplementation(
            (model: Parameters<typeof createAssistant>[0]) =>
              createAssistantResultStream(createAssistant(model, [{ type: "text", text: "done" }])),
          );
          await session.prompt("Consume accepted guidance.");
          const reopened = await SessionManager.openAsync(target, state.workspaceDir);
          const delivered = reopened
            .buildSessionContext()
            .messages.filter(
              (entry) => entry.role === "user" && JSON.stringify(entry).includes(message),
            );
          expect(delivered).toHaveLength(rejected ? 0 : 1);
          expect(
            callGateway.mock.calls.every(([request]) => request.method === "sessions.resolve"),
          ).toBe(true);
        } finally {
          resumePreparation.resolve();
          await Promise.allSettled([pending]);
          releaseAgentRunDelegatedAuthority(authority);
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          unregisterClosed();
          questions.close();
          await questions.drain();
          session.dispose();
        }
      });
    },
  );
});
