import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
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
  it.each(["live", "revoked", "unscoped", "unscoped-policy-revoked"] as const)(
    "checks the %s source at the real final enqueue and preserves accepted input",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { ownership: "explicit", entries: { main: {} } },
          tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        } satisfies OpenClawConfig;
        setRuntimeConfigSnapshot(cfg);
        setActivePluginRegistry(createSessionConversationTestRegistry());
        const requesterSessionKey = "agent:main:dashboard:queue-source";
        const sessionKey = "agent:main:cron:queue-target:run:active";
        const sessionId = "queue-target-session";
        for (const [key, id] of [
          [requesterSessionKey, "queue-source-session"],
          [sessionKey, sessionId],
        ] as const) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key },
            { sessionId: id, updatedAt: 1 },
          );
        }
        const target = await resolveSessionTranscriptRuntimeTarget({
          agentId: "main",
          sessionId,
          sessionKey,
        });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        guardSessionManager(manager);
        const { session } = await createTestSession({ sessionManager: manager });
        const queued = vi.spyOn(session.agent, "steer");
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
          await session.steer(text, undefined, recorder, undefined, undefined, undefined, () => {
            assertCurrent?.();
            return true;
          });
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
          ...(source.startsWith("unscoped")
            ? { messageInjection: { isAvailable: () => true, queueMessage } }
            : {
                messageInjectionV2: {
                  version: 2 as const,
                  isAvailable: () => true,
                  queueMessage,
                },
              }),
        };
        setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
        const instance = createOperationalRunInstanceRef("queue-source-run");
        const authority = claimAgentRunDelegatedAuthority(instance);
        // Resolution is read-only; the real queue and SQLite transcript perform every effect.
        const callGateway = vi
          .fn()
          .mockImplementation(async (request: Parameters<AgentToolGatewayRequestCaller>[0]) => {
            if (request.method !== "sessions.resolve") {
              throw new Error(`Unexpected Gateway dispatch: ${request.method}`);
            }
            return { key: sessionKey, agentId: "main" };
          });
        const message = `guidance-from-${source}-source`;
        const send = () =>
          createSessionsSendTool({
            config: cfg,
            agentSessionKey: requesterSessionKey,
            expectedTargetSessionId: sessionId,
            expectedTargetStorePath: target.storePath,
            callGateway,
          }).execute("source-send", { sessionKey, message, timeoutSeconds: 0 });
        const pending = source.startsWith("unscoped")
          ? send()
          : withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: requesterSessionKey,
                operationalRunInstance: instance,
                approvalAuthority: authority,
                receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
              },
              send,
            );
        try {
          await Promise.race([preparation.promise, pending]);
          expect(queued).not.toHaveBeenCalled();
          if (source === "revoked") {
            releaseAgentRunDelegatedAuthority(authority);
          }
          if (source === "unscoped-policy-revoked") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              { sessionId, updatedAt: 2, communication: { receive: "never" } },
            );
          }
          resumePreparation.resolve();
          const result = await pending;
          if (source === "revoked" || source === "unscoped-policy-revoked") {
            expect(result.details).toMatchObject({ status: "error" });
            expect(JSON.stringify(result)).toContain(
              source === "revoked"
                ? "Message injection authority is no longer current"
                : "communication state changed",
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
          expect(delivered).toHaveLength(
            source === "revoked" || source === "unscoped-policy-revoked" ? 0 : 1,
          );
          expect(
            callGateway.mock.calls.every(([request]) => request.method === "sessions.resolve"),
          ).toBe(true);
        } finally {
          resumePreparation.resolve();
          await Promise.allSettled([pending]);
          releaseAgentRunDelegatedAuthority(authority);
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          session.dispose();
        }
      });
    },
  );
});
