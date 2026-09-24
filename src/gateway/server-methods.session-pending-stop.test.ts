import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgentDedupeLifecycle } from "./agent-turn/agent-dedupe-lifecycle.js";
import { prepareAgentRequestRouting } from "./agent-turn/agent-request-routing.js";
import { createAgentTurnIo } from "./agent-turn/io.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { admitChatSend } from "./server-methods/chat-send-admission.js";
import { normalizeChatSendRequest } from "./server-methods/chat-send-request.js";
import { prepareChatSendSession } from "./server-methods/chat-send-session.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const key = "agent:main:pending-stop";

describe("pending Stop producer binding", () => {
  it.each(["current", "replacement"] as const)(
    "uses the agent reservation's original row across %s admission",
    async (target) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "pending-agent-owner");
        client.connId = "pending-owner";
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        const entry = {
          sessionId: "original",
          updatedAt: 1,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: client.authenticatedUserProfile!.profileId,
          },
        };
        await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
        const runId = `pending-agent-${target}`;
        const request = {
          message: "queued",
          sessionKey: key,
          agentId: "main",
          idempotencyKey: runId,
        };
        const lifecycle = createAgentDedupeLifecycle({
          cfg,
          request,
          runId,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          agentDedupeKeys: [`agent:${runId}`],
          suppressVisibleSessionEffects: false,
          ownerConnId: client.connId,
          context,
          io: createAgentTurnIo(vi.fn()),
        });
        expect(
          await prepareAgentRequestRouting({
            cfg,
            request,
            runId,
            context,
            respond: vi.fn(),
            isRawModelRun: false,
            agentDedupeKeys: [`agent:${runId}`],
            reserveDedupe: lifecycle.reserve,
            bindDedupeSessionTarget: lifecycle.bindSessionTarget,
            clearDedupe: lifecycle.clearUnaccepted,
          }),
        ).toBeDefined();
        expect(context.chatAbortControllers.size).toBe(0);
        const pending = context.dedupe.get(`agent:${runId}`);
        if (target === "replacement") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: key },
            { ...entry, sessionId: "replacement" },
          );
        }
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "stop",
            method: "chat.abort",
            params: { sessionKey: key, runId },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { "chat.abort": handleChatAbortRequest },
        });
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ aborted: target === "current" });
        if (target === "replacement") {
          expect(context.dedupe.get(`agent:${runId}`)).toBe(pending);
        } else {
          expect(context.dedupe.get(`agent:${runId}`)?.payload).toMatchObject({
            status: "timeout",
            summary: "aborted",
          });
        }
      });
    },
  );

  it("keeps a real chat admission abortable while its original session lifecycle is held", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const client = roleClient("view", "pending-chat-owner");
      client.connId = "pending-owner";
      client.connect.scopes = ["operator.sessions.write"];
      const cfg = rolePolicyConfig();
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "original",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        },
      );
      const runId = "pending-chat-admission";
      const request = normalizeChatSendRequest({
        params: { sessionKey: key, message: "queued", idempotencyKey: runId },
        client,
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const session = prepareChatSendSession({ request: request.value, client, context });
      if (!session.ok) {
        throw new Error("chat session preparation failed");
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const hold = runExclusiveSessionLifecycleMutation({
        scope: session.value.storePath,
        identities: [key, "original"],
        run: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      await entered.promise;
      const admission = admitChatSend({
        request: request.value,
        session: session.value,
        client,
        context,
        respond: vi.fn(),
      });
      try {
        await vi.waitFor(() =>
          expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true),
        );
        expect(context.chatAbortControllers.has(runId)).toBe(false);
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "stop",
            method: "chat.abort",
            params: { sessionKey: key, runId },
          },
          client,
          context,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: { "chat.abort": handleChatAbortRequest },
        });
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ aborted: true, runIds: [runId] });
        expect(context.dedupe.get(`chat:${runId}`)?.payload).toMatchObject({
          status: "timeout",
          summary: "aborted",
        });
      } finally {
        release.resolve();
        await hold;
        const settled = await admission;
        if (settled.ok) {
          settled.value.cleanupAdmittedRun();
        }
        expect(settled.ok).toBe(false);
      }
    });
  });
});
