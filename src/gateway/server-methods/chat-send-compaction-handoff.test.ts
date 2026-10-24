import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import * as dispatchRuntimeLoaders from "../../auto-reply/reply/dispatch-from-config.runtime-loaders.js";
import type { InternalGetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import {
  getSessionControllerOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient } from "./types.js";

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
      const prepared = createDeferred();
      const releasePreparation = createDeferred();
      const capturedSuccessor = createDeferred();
      const releaseRuntimePlugins = createDeferred();
      const originalLoadRuntimePlugins = dispatchRuntimeLoaders.loadRuntimePlugins;
      const holdRuntimePlugins =
        scenario === "successive-compactions"
          ? vi.spyOn(dispatchRuntimeLoaders, "loadRuntimePlugins").mockImplementation(async () => {
              capturedSuccessor.resolve();
              await releaseRuntimePlugins.promise;
              return await originalLoadRuntimePlugins();
            })
          : undefined;

      const originalDispatch = dispatch.dispatchInboundMessageWithProjectedDispatcher;
      const observeChatDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      let owned: ChatDispatchParams | undefined;
      let successor: ReplyOperation | undefined;
      let successorInput: SessionControllerInput | undefined;
      let successorClaim: SessionControllerMailboxClaim | undefined;
      let sourceRef: ChatDispatchParams["admission"]["sourceRef"] | undefined;
      const resolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options, replyConfig) => {
        if (!options || !replyConfig || !owned || !sourceRef) {
          throw new Error("fixture requires the original accepted chat dispatch");
        }
        expect(ctx.BodyForAgent).toBe(message);
        expect(options).toMatchObject({ runId, expectedExistingSessionId: finalSessionId });
        const initialized = await initSessionState({
          ctx: finalizeInboundContext(ctx),
          cfg: replyConfig,
          commandAuthorized: ctx.CommandAuthorized === true,
          expectedExistingSessionId: options.expectedExistingSessionId,
          requestedSessionId: options.requestedSessionId,
          signal: options.abortSignal,
        });
        expect(initialized.sessionId, "initialized session").toBe(finalSessionId);
        options.onSessionPrepared?.({
          sessionKey: initialized.sessionKey,
          sessionId: initialized.sessionId,
          storePath: initialized.storePath,
        });
        expect(rpcSourceTesting.get(runId)).toBe(sourceRef);
        expect(getRpcSourceIdentity(sourceRef).sessionId).toBe(finalSessionId);
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
      let releaseAuthorization: (() => void) | undefined;
      try {
        if (scenario === "successive-compactions") {
          // The queued compaction precedes this chat input in the same mailbox.
          successorInput = reserveSessionControllerSource(sessionKey, {
            target: captureSessionTarget({ storeScope: storePath, sessionKey, agentId }),
            policy: { mode: "followup" },
          });
        }
        const params = { sessionKey, sessionId: initialSessionId, message, idempotencyKey: runId };
        const authorization = await resolveSessionMutationAuthorizationAsync({
          client,
          context,
          method: "chat.send",
          requestParams: params,
        });
        releaseAuthorization = authorization.authorization?.release;
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
        await prepared.promise;
        owned = expectDefined(
          observeChatDispatch.mock.calls.at(-1)?.[0],
          "chat.send did not start detached dispatch",
        );
        sourceRef = owned.admission.sourceRef;
        expect(getRpcSourceIdentity(sourceRef).sessionId).toBe(initialSessionId);
        expect(owned.admission.expectedActiveReplyOperation).toBe(
          scenario === "foreign-store" ? undefined : predecessor,
        );

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
          expect(getSessionControllerOperation(sessionKey)).toBe(predecessor);
        } else {
          predecessor.complete();
          await predecessor.ownerSettlement;
          expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
        }
        if (scenario === "cancelled") {
          owned.admission.activeRunAbort.controller.abort();
        }
        if (successorInput) {
          successorClaim = await claimSessionControllerTask(successorInput, () => {}, "visible");
          const successorAdmission = await admitReplyTurn({
            ...scope,
            mailboxClaim: successorClaim,
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
          await capturedSuccessor.promise;
          await replaceSessionEntry(scope, { ...entry, sessionId: finalSessionId });
          successor.updateSessionId(finalSessionId);
          successor.complete();
          await successor.ownerSettlement;
          if (successorClaim) {
            releaseSessionControllerClaim(successorClaim);
            await successorClaim.settlement.promise;
          }
          expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
          releaseRuntimePlugins.resolve();
        }
        // Source cleanup follows post-dispatch persistence and the Gateway root's release.
        await owned.admission.gatewayWorkAdmission.released;
        expect(rpcSourceTesting.has(runId)).toBe(false);

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
          expect(getRpcSourceIdentity(sourceRef).sessionId).toBe(finalSessionId);
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
          expect(getRpcSourceIdentity(sourceRef).sessionId).toBe(initialSessionId);
        }
      } finally {
        predecessor.complete();
        successor?.complete();
        if (successorClaim) {
          releaseSessionControllerClaim(successorClaim);
        } else if (successorInput) {
          retireSessionControllerInput(successorInput);
        }
        releasePreparation.resolve();
        releaseRuntimePlugins.resolve();
        await successorInput?.settlement.promise;
        if (owned) {
          await owned.admission.gatewayWorkAdmission.released;
        }
        releaseAuthorization?.();
        holdPreparation.mockRestore();
        holdRuntimePlugins?.mockRestore();
        observeChatDispatch.mockRestore();
      }
    });
  },
);
