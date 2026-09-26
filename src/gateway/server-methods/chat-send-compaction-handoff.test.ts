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
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];
type ChatDispatchParams = Parameters<typeof chatDispatch.startChatDispatch>[0];

it.each([
  "compaction",
  "active-compaction",
  "successive-compactions",
  "replacement",
  "foreign-store",
  "restart",
  "cancelled",
] as const)(
  "retains the accepted chat target while preparation outlives its predecessor: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      await state.writeConfig({
        agents: { defaults: { workspace: state.workspaceDir } },
        plugins: { enabled: false },
        session: { store: storePath },
      });
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
      const previousAdmission = await admitReplyTurn({
        ...predecessorScope,
        sessionId: initialSessionId,
        kind: "visible",
        resetTriggered: false,
      });
      if (previousAdmission.status !== "owned" || !previousAdmission.databaseClaim) {
        throw new Error("fixture requires the predecessor's real physical database admission");
      }
      const predecessor = previousAdmission.operation;
      predecessor.setPhase("running");

      const client: GatewayClient = {
        connId: "compaction-handoff-client",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const context = createGatewayRequestContext(makeContextParams());
      const prepared = createDeferred<DispatchOptions>();
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
      const originalStartChatDispatch = chatDispatch.startChatDispatch;
      const dispatchOwner: {
        params?: ChatDispatchParams;
        completion?: Promise<void>;
        settled?: Promise<void>;
      } = {};
      // Capture dispatch before an ACK assertion can fail; registration removal is not a drain.
      const observeChatDispatch = vi
        .spyOn(chatDispatch, "startChatDispatch")
        .mockImplementation((params) => {
          dispatchOwner.params = params;
          const completion = originalStartChatDispatch(params);
          dispatchOwner.completion = completion;
          dispatchOwner.settled = completion.then(
            () => undefined,
            () => undefined,
          );
          return completion;
        });
      let owned: ChatDispatchParams | undefined;
      let successor: ReplyOperation | undefined;
      let originalRegistration: ChatDispatchParams["admission"]["sessionBinding"] | undefined;
      const resolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options, cfg) => {
        if (!options || !cfg || !owned || !originalRegistration) {
          throw new Error("fixture requires the original accepted chat dispatch");
        }
        expect(ctx.BodyForAgent).toBe(message);
        expect(options.runId).toBe(runId);
        expect(options.expectedExistingSessionId).toBe(finalSessionId);
        const initialized = await initSessionState({
          ctx: finalizeInboundContext(ctx),
          cfg,
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
          prepared.resolve(options);
          await releasePreparation.promise;
          return await originalDispatch({ ...options, replyResolver: resolver });
        });
      try {
        const params = { sessionKey, sessionId: initialSessionId, message, idempotencyKey: runId };
        const authorization = resolveSessionMutationAuthorization({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        expect(authorization.error).toBeNull();
        const respond = vi.fn();
        await handleChatSend({
          params,
          req: { type: "req", id: runId, method: "chat.send" },
          respond,
          context,
          client,
          sessionMutationAuthorization: authorization.authorization,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: "started" }),
          undefined,
          expect.anything(),
        );
        owned = dispatchOwner.params;
        const completion = dispatchOwner.completion;
        if (!owned || !completion) {
          throw new Error("chat.send did not start detached dispatch");
        }
        await Promise.race([
          prepared.promise,
          completion.then(() => {
            throw new Error("chat dispatch finished before preparation");
          }),
        ]);
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
          const successorAdmission = await admitReplyTurn({
            ...scope,
            sessionId: nextSessionId,
            expectedSessionId: nextSessionId,
            kind: "visible",
            resetTriggered: false,
          });
          if (successorAdmission.status !== "owned" || !successorAdmission.databaseClaim) {
            throw new Error("fixture requires the successor's real physical database admission");
          }
          successor = successorAdmission.operation;
          successor.setPhase("running");
        }
        releasePreparation.resolve();
        if (successor) {
          // Gather retains this newer owner before its existing plugin-loading await.
          await Promise.race([
            capturedSuccessor.promise,
            completion.then(() => {
              throw new Error("chat dispatch finished before capturing its successor");
            }),
          ]);
          await replaceSessionEntry(scope, { ...entry, sessionId: finalSessionId });
          successor.updateSessionId(finalSessionId);
          successor.complete();
          await successor.ownerSettlement;
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          releaseRuntimePlugins.resolve();
        }
        await completion;
        await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));

        if (
          scenario === "compaction" ||
          scenario === "active-compaction" ||
          scenario === "successive-compactions"
        ) {
          expect(context.broadcast).not.toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({ runId, state: "error" }),
            expect.anything(),
          );
          expect(resolver).toHaveBeenCalledOnce();
          expect(originalRegistration.sessionId).toBe(finalSessionId);
          expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
            ok: true,
            payload: { runId, status: "ok" },
          });
          const transcript = await loadTranscriptEvents({ ...scope, sessionId: finalSessionId });
          expect(
            transcript.filter(
              (event) =>
                isRecord(event) &&
                event.type === "message" &&
                isRecord(event.message) &&
                event.message.role === "user",
            ),
          ).toHaveLength(1);
        } else {
          expect(resolver).not.toHaveBeenCalled();
          expect(originalRegistration.sessionId).toBe(initialSessionId);
        }
      } finally {
        predecessor.complete();
        successor?.complete();
        releasePreparation.resolve();
        releaseRuntimePlugins.resolve();
        await dispatchOwner.settled;
        dispatchOwner.params?.admission.cleanupAdmittedRun();
        holdPreparation.mockRestore();
        holdRuntimePlugins?.mockRestore();
        observeChatDispatch.mockRestore();
      }
    });
  },
);
