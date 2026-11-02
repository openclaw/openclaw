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
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import type { GatewayClient } from "./types.js";

type ChatDispatchParams = Parameters<typeof chatDispatch.startChatDispatch>[0];

it("retains the accepted chat target through successive compactions during preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const agentId = "main";
    const sessionKey = "agent:main:compaction-handoff";
    const initialSessionId = "before-compaction";
    const nextSessionId = "after-compaction";
    const finalSessionId = "after-second-compaction";
    const runId = "accepted-before-compaction";
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
      lifecycleRevision: "compaction-handoff-lifecycle",
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: profile.id } as const,
    };
    await replaceSessionEntry(scope, entry);
    const previousAdmission = await admitReplyTurn({
      ...scope,
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
      authenticatedUserProfile: gatewayProfile(profile.id),
      connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"], {
        id: "cli",
        mode: "cli",
      }),
    };
    const context = createGatewayRequestContext(makeContextParams());
    const prepared = createDeferred();
    const releasePreparation = createDeferred();
    const capturedSuccessor = createDeferred();
    const releaseRuntimePlugins = createDeferred();
    const originalLoadRuntimePlugins = dispatchRuntimeLoaders.loadRuntimePlugins;
    const holdRuntimePlugins = vi
      .spyOn(dispatchRuntimeLoaders, "loadRuntimePlugins")
      .mockImplementation(async () => {
        capturedSuccessor.resolve();
        await releaseRuntimePlugins.promise;
        return await originalLoadRuntimePlugins();
      });

    const originalDispatch = dispatch.dispatchInboundMessageWithProjectedDispatcher;
    const observeChatDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
    let owned: ChatDispatchParams | undefined;
    let successor: ReplyOperation | undefined;
    let successorInput: SessionControllerInput | undefined;
    let successorClaim: SessionControllerMailboxClaim | undefined;
    const resolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options, replyConfig) => {
      if (!options || !replyConfig) {
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
      expect(initialized.sessionId, "initialized session").toBe(finalSessionId);
      options.onSessionPrepared?.({
        sessionKey: initialized.sessionKey,
        sessionId: initialized.sessionId,
        storePath: initialized.storePath,
      });
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
      // The queued compaction precedes this chat input in the same mailbox.
      successorInput = reserveSessionControllerSource(sessionKey, {
        target: captureSessionTarget({ storeScope: storePath, sessionKey, agentId }),
        policy: { mode: "followup" },
      });
      const params = { sessionKey, sessionId: initialSessionId, message, idempotencyKey: runId };
      const [ok, response] = await chatRpc(context, client, "chat.send", params);
      expect([ok, response]).toEqual([true, expect.objectContaining({ runId, status: "started" })]);
      await prepared.promise;
      owned = expectDefined(
        observeChatDispatch.mock.calls.at(-1)?.[0],
        "chat.send did not start detached dispatch",
      );
      await replaceSessionEntry(scope, { ...entry, sessionId: nextSessionId });
      predecessor.updateSessionId(nextSessionId);
      predecessor.complete();
      await predecessor.ownerSettlement;
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
        releaseRuntimePlugins.resolve();
      }
      // Source cleanup follows post-dispatch persistence and the Gateway root's release.
      await owned.admission.gatewayWorkAdmission.released;
      expect(rpcSourceTesting.has(runId)).toBe(false);

      expect(context.broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error" }),
        expect.anything(),
      );
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
      holdPreparation.mockRestore();
      holdRuntimePlugins.mockRestore();
      observeChatDispatch.mockRestore();
    }
  });
});
