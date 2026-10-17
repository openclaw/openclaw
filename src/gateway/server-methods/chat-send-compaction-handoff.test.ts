import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import * as dispatchRuntimeLoaders from "../../auto-reply/reply/dispatch-from-config.runtime-loaders.js";
import type { InternalGetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  replyRunRegistry,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";

type ChatDispatchParams = Parameters<typeof chatDispatch.startChatDispatch>[0];

async function runningReply(params: Parameters<typeof admitReplyTurn>[0]) {
  const admitted = await admitReplyTurn(params);
  if (admitted.status !== "owned" || !admitted.databaseClaim) {
    throw new Error("fixture requires a real physical database admission");
  }
  admitted.operation.setPhase("running");
  return admitted.operation;
}

it.each([
  ["compaction", true],
  ["active-compaction", true],
  ["successive-compactions", true],
  ["replacement", false],
  ["foreign-store", false],
  ["restart", false],
  ["cancelled", false],
] as const)(
  "retains the accepted chat target while preparation outlives its predecessor: %s",
  async (scenario, continues) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const agentId = "main";
      const sessionKey = "agent:main:compaction-handoff";
      const initialSessionId = "before-compaction";
      const nextSessionId = "after-compaction";
      const finalSessionId =
        scenario === "successive-compactions" ? "after-second-compaction" : nextSessionId;
      const runId = `accepted-before-compaction-${scenario}`;
      const message = "Continue the existing task with this exact input.";
      const storePath = state.statePath("sessions.sqlite");
      const scope = { agentId, sessionKey, storePath };
      const cfg = {
        agents: { defaults: { workspace: state.workspaceDir } },
        plugins: { enabled: false },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const profile = ensureProfileForEmail("compaction-handoff@example.test");
      const entry = {
        sessionId: initialSessionId,
        updatedAt: Date.now(),
        createdActor: { type: "human", source: "profile", id: profile.id } as const,
      };
      await replaceSessionEntry(scope, entry);
      const predecessorScope = {
        ...scope,
        storePath: scenario === "foreign-store" ? state.statePath("foreign.sqlite") : storePath,
      };
      if (scenario === "foreign-store") {
        await replaceSessionEntry(predecessorScope, entry);
      }
      const predecessor = await runningReply({
        ...predecessorScope,
        sessionId: initialSessionId,
        kind: "visible",
        resetTriggered: false,
      });
      const client = createOperatorClient({
        profileId: profile.id,
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
      client.connect.client = { id: "cli", version: "test", platform: "test", mode: "cli" };
      const context = createGatewayRequestContext(makeContextParams());
      const prepared = createDeferred();
      const releasePreparation = createDeferred();
      const capturedSuccessor = createDeferred();
      const releaseRuntimePlugins = createDeferred();
      const originalDispatch = dispatch.dispatchInboundMessageWithProjectedDispatcher;
      const originalLoadRuntimePlugins = dispatchRuntimeLoaders.loadRuntimePlugins;
      const holdRuntimePlugins =
        scenario === "successive-compactions"
          ? vi.spyOn(dispatchRuntimeLoaders, "loadRuntimePlugins").mockImplementation(async () => {
              capturedSuccessor.resolve();
              await releaseRuntimePlugins.promise;
              return await originalLoadRuntimePlugins();
            })
          : undefined;
      using observeChatDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      let owned: ChatDispatchParams | undefined;
      let successor: ReplyOperation | undefined;
      let originalRegistration: ChatDispatchParams["admission"]["sessionBinding"] | undefined;
      const resolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options, replyConfig) => {
        if (!options || !replyConfig || !owned || !originalRegistration) {
          throw new Error("fixture requires the original accepted chat dispatch");
        }
        expect(ctx.BodyForAgent).toBe(message);
        const initialized = await initSessionState({
          ctx: finalizeInboundContext(ctx),
          cfg: replyConfig,
          commandAuthorized: ctx.CommandAuthorized === true,
          expectedExistingSessionId: options.expectedExistingSessionId,
          requestedSessionId: options.requestedSessionId,
          signal: options.abortSignal,
        });
        expect(initialized.sessionId).toBe(finalSessionId);
        options.onSessionPrepared?.({
          sessionKey: initialized.sessionKey,
          sessionId: initialized.sessionId,
          storePath: initialized.storePath,
        });
        expect(context.chatAbortControllers.get(runId)).toBe(originalRegistration);
        expect(originalRegistration.sessionId).toBe(finalSessionId);
        await options.userTurnTranscriptRecorder?.persistApproved();
        return { text: "Continued in the compacted conversation." };
      });
      const holdPreparation = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          prepared.resolve();
          await releasePreparation.promise;
          return await originalDispatch({ ...options, replyResolver: resolver });
        });
      try {
        const params = { sessionKey, sessionId: initialSessionId, message, idempotencyKey: runId };
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: runId, method: "chat.send", params },
          respond,
          context,
          client,
          extraHandlers: { "chat.send": handleChatSend },
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: "started" }),
          undefined,
          expect.anything(),
        );
        await prepared.promise;
        owned = expectDefined(
          observeChatDispatch.mock.calls.at(-1)?.[0],
          "chat.send did not start detached dispatch",
        );
        originalRegistration = owned.admission.sessionBinding;
        expect(originalRegistration.sessionId).toBe(initialSessionId);

        await replaceSessionEntry(scope, { ...entry, sessionId: nextSessionId });
        if (scenario === "foreign-store") {
          await replaceSessionEntry(predecessorScope, { ...entry, sessionId: nextSessionId });
        }
        if (scenario !== "replacement") {
          predecessor.updateSessionId(nextSessionId);
        }
        if (scenario === "restart") {
          predecessor.abortForRestart();
        }
        if (scenario === "active-compaction") {
          expect(replyRunRegistry.get(sessionKey)).toBe(predecessor);
        } else {
          predecessor.complete();
          await predecessor.ownerSettlement;
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
        }
        if (scenario === "cancelled") {
          owned.admission.activeRunAbort.controller.abort();
        }
        if (scenario === "successive-compactions") {
          successor = await runningReply({
            ...scope,
            sessionId: nextSessionId,
            expectedSessionId: nextSessionId,
            kind: "visible",
            resetTriggered: false,
          });
        }
        releasePreparation.resolve();
        if (successor) {
          // Gather retains this newer owner before its existing plugin-loading await.
          await capturedSuccessor.promise;
          await replaceSessionEntry(scope, { ...entry, sessionId: finalSessionId });
          successor.updateSessionId(finalSessionId);
          successor.complete();
          await successor.ownerSettlement;
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          releaseRuntimePlugins.resolve();
        }
        // Admission release follows the chat owner's post-dispatch persistence and cleanup.
        await owned.admission.gatewayWorkAdmission.released;
        expect(context.chatAbortControllers.has(runId)).toBe(false);

        if (continues) {
          expect(context.broadcast).not.toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({ runId, state: "error" }),
            expect.anything(),
          );
          expect(resolver).toHaveBeenCalledOnce();
          expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
            ok: true,
            payload: { runId, status: "ok" },
          });
          const transcript = await loadTranscriptEvents({ ...scope, sessionId: finalSessionId });
          const users = transcript.filter(
            (event) =>
              isRecord(event) &&
              event.type === "message" &&
              isRecord(event.message) &&
              event.message.role === "user",
          );
          expect(users).toHaveLength(1);
        } else {
          expect(resolver).not.toHaveBeenCalled();
          expect(originalRegistration.sessionId).toBe(initialSessionId);
        }
      } finally {
        predecessor.complete();
        successor?.complete();
        releasePreparation.resolve();
        releaseRuntimePlugins.resolve();
        if (owned) {
          await owned.admission.gatewayWorkAdmission.released;
        }
        holdPreparation.mockRestore();
        holdRuntimePlugins?.mockRestore();
      }
    });
  },
);
