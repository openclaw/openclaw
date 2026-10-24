import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import {
  getAgentRunContext,
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../infra/agent-run-registry.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  releaseSessionControllerClaim,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  getRpcSourceProjectSessionActive,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { progressCardStore } from "../progress-card-store.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { progressCardHandlers } from "./progress-card.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

installGatewayTestHooks();
const prepareProfiles = useUserProfileCatalogForTest();
beforeEach(async () => {
  await prepareProfiles();
});
const createFixture = useBrowserFollowupFixture();
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Dispatch = Parameters<typeof dispatchInboundMessage>[0];
const acceptedResponse = () => [
  true,
  expect.objectContaining({ status: "accepted", revision: 1 }),
  undefined,
  expect.anything(),
];
const terminalResponse = () => [
  false,
  undefined,
  expect.objectContaining({ details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } }),
  expect.anything(),
];
const putCard = (f: Fixture, markdown: string) =>
  progressCardStore.put(f.scope.sessionKey, { markdown }, f.scope.agentId);
const transcriptMessages = (rows: Fixture["activeTranscript"]) =>
  rows.flatMap((row) => (isRecord(row) && isRecord(row.message) ? [row.message] : []));
function expectNoChat(f: Fixture) {
  expect(
    vi.mocked(f.context.broadcast).mock.calls.filter(([event]) => event === "chat"),
  ).toHaveLength(0);
}

async function claimRefreshOperation(f: Fixture, runId: string) {
  const source = rpcSourceTesting.get(runId);
  if (!source) {
    throw new Error("Missing controller-owned refresh source");
  }
  if (f.activeRun && !f.activeRun.result) {
    f.activeRun.complete();
    await f.activeRun.ownerSettlement;
  }
  const claim = tryClaimSessionControllerTask(source.input);
  if (!claim) {
    throw new Error("Refresh source was not selected by its controller");
  }
  const operation = createReplyOperation({
    ...f.scope,
    resetTriggered: false,
    mailboxClaim: claim,
  });
  return {
    operation,
    source,
    release: () => {
      operation.complete();
      releaseSessionControllerClaim(claim);
    },
  };
}

async function refreshCard(
  f: Fixture,
  idempotencyKey: string,
  respond = vi.fn<RespondFn>(),
  options: { id?: string; client?: GatewayClient; extraHandlers?: GatewayRequestHandlers } = {},
) {
  await handleGatewayRequest({
    req: {
      type: "req",
      id: options.id ?? "refresh",
      method: "progressCard.refresh",
      params: { sessionKey: f.scope.sessionKey, idempotencyKey },
    },
    client: options.client ?? f.client,
    context: f.context,
    respond,
    isWebchatConnect: () => true,
    extraHandlers: options.extraHandlers ?? progressCardHandlers,
  });
  return respond;
}

describe("registered progress refresh admission", () => {
  it.each([false, true])(
    "reconciles a completed retry under current authority (revoke=%s)",
    async (revoke) => {
      const owner = revoke ? roleClient("view", "refresh-session-owner") : undefined;
      const caller = revoke ? roleClient("write", "refresh-requester") : undefined;
      const f = await createFixture({
        active: false,
        preserveContent: true,
        createdActor: owner
          ? {
              type: "human" as const,
              source: "profile" as const,
              id: owner.authenticatedUserProfile!.profileId,
            }
          : undefined,
      });
      using _ = caller
        ? { [Symbol.dispose]: (await prepareUserProfileCatalog()).release }
        : undefined;
      try {
        if (caller) {
          prepareGatewayRecipientProfile(caller);
          const cfg = { ...f.context.getRuntimeConfig(), ...rolePolicyConfig() };
          f.context.getRuntimeConfig = () => cfg;
        }
        const cardRead = createDeferredCore();
        const releaseRead = createDeferredCore();
        const handlers = { ...progressCardHandlers };
        let readingTerminalCard = false;
        let revoked = false;
        const originalRefresh = handlers["progressCard.refresh"]!;
        handlers["progressCard.refresh"] = async (invocation) => {
          if (caller) {
            const authorization = invocation.sessionMutationAuthorization!;
            const assertCurrent = authorization.assertCurrent.bind(authorization);
            authorization.assertCurrent = () => {
              assertCurrent();
              if (readingTerminalCard) {
                readingTerminalCard = false;
                // Revoke after the reader's check, before its caller resumes to publish.
                queueMicrotask(() => {
                  const { profileId } = caller.authenticatedUserProfile!;
                  setUserProfileRole(profileId, "view");
                  invalidateOperatorRolePolicy(profileId);
                  revoked = true;
                });
              }
            };
          }
          await originalRefresh(invocation);
        };
        const refresh = async (respond = vi.fn<RespondFn>()) =>
          refreshCard(f, "finishing-refresh", respond, {
            client: caller ?? f.client,
            extraHandlers: handlers,
          });
        await putCard(f, "Old status");
        const accepted = await refresh();
        expect(accepted).toHaveBeenCalledWith(...acceptedResponse());
        await (await f.dispatchedRecorder).persistApproved();
        const receipt = [...f.context.dedupe.entries()].find(([key]) =>
          key.startsWith("progressCard.refresh:"),
        );
        expect(receipt).toBeDefined();
        const readCard = progressCardStore.get.bind(progressCardStore);
        const get = vi
          .spyOn(progressCardStore, "get")
          .mockImplementationOnce(async (...args) => {
            const card = await readCard(...args);
            cardRead.resolve();
            await releaseRead.promise;
            return card;
          })
          .mockImplementationOnce(async (...args) => {
            const card = await readCard(...args);
            readingTerminalCard = revoke;
            return card;
          });
        const retry = vi.fn<RespondFn>();
        const pending = refresh(retry);
        try {
          await cardRead.promise;
          await putCard(f, "Fresh status");
          await f.finishDispatch();
          releaseRead.resolve();
          await pending;
          if (revoke) {
            expect(revoked).toBe(true);
            expect(f.context.dedupe.get(receipt![0])).toBe(receipt![1]);
            expect(retry).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
              }),
            );
          } else {
            expect(retry).toHaveBeenCalledExactlyOnceWith(...acceptedResponse());
          }
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        } finally {
          releaseRead.resolve();
          await pending;
          get.mockRestore();
        }
      } finally {
        await f.cleanup();
      }
    },
  );
  it("deduplicates concurrent refresh bursts with distinct intents through completion", async () => {
    const intentCount = 2;
    await using f = await createFixture({ active: false, preserveContent: true });
    const dispatched = createDeferredCore();
    const dispatch = dispatchInboundMessageMock.getMockImplementation()!;
    dispatchInboundMessageMock.mockImplementation((...args) => {
      const result = dispatch(...args);
      if (dispatchInboundMessageMock.mock.calls.length === intentCount) {
        dispatched.resolve();
      }
      return result;
    });
    const burst = () =>
      Promise.all(
        Array.from({ length: 2 * intentCount }, (_, index) =>
          refreshCard(f, `burst-${index % intentCount}`),
        ),
      );
    const expectAccepted = (responses: Awaited<ReturnType<typeof burst>>) => {
      const runIds = new Set<unknown>();
      for (const response of responses) {
        expect(response).toHaveBeenCalledExactlyOnceWith(...acceptedResponse());
        const payload = response.mock.calls[0]?.[1];
        expect(payload).toHaveProperty("runId", expect.any(String));
        runIds.add(isRecord(payload) ? payload.runId : undefined);
      }
      expect(runIds.size).toBe(intentCount);
    };
    await putCard(f, "Old status");
    expectAccepted(await burst());
    await dispatched.promise;
    for (const [params] of dispatchInboundMessageMock.mock.calls) {
      const admitted = params as Dispatch;
      expect(admitted.toolsAllow).toContain("progress_card");
      expect(admitted.toolsAllow).not.toContain("exec");
      await admitted.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
    }
    await f.finishDispatch();
    for (const response of await burst()) {
      expect(response).toHaveBeenCalledExactlyOnceWith(...terminalResponse());
    }
    await putCard(f, "Current status");
    expectAccepted(await burst());
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(intentCount);
    const messages = transcriptMessages(loadTranscriptEventsSync(f.scope));
    expect(messages.filter((message) => message.display === false)).toHaveLength(intentCount);
    expect(projectChatDisplayMessages(messages)).toEqual(
      projectChatDisplayMessages(transcriptMessages(f.activeTranscript)),
    );
    expectNoChat(f);
  });
  it.each([false, true])(
    "starts a hidden status-only turn when idle or steering is unavailable (active=%s)",
    async (active) => {
      await using f = await createFixture({ active, preserveContent: true });
      let releaseRefresh: (() => void) | undefined;
      try {
        await putCard(f, "Previous status");
        const respond = await refreshCard(f, "refresh-click");
        expect(respond).toHaveBeenCalledWith(...acceptedResponse());
        const payload = respond.mock.calls[0]?.[1];
        if (!isRecord(payload) || typeof payload.runId !== "string") {
          throw new Error("Missing refresh run");
        }
        const recorder = await f.dispatchedRecorder;
        expect(await recorder.resolveMessage()).toMatchObject({
          display: false,
          provenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
        });
        expect(getAgentRunContext(payload.runId)).toMatchObject({
          isControlUiVisible: false,
          projectSessionMessages: false,
          projectSessionActive: false,
          projectSessionLifecycle: false,
        });
        const source = rpcSourceTesting.get(payload.runId);
        expect(source?.adapter).toMatchObject({ controlUiVisible: false });
        const dispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as Dispatch;
        expect(dispatch.ctx.InternalTurnSource).toBe("progress-card-refresh");
        expect(dispatch.ctx.InputProvenance).toMatchObject({ sourceTool: "progress_card_refresh" });
        expect(dispatch.toolsAllow).toContain("progress_card");
        expect(dispatch.toolsAllow).not.toContain("exec");
        const prepared = dispatch.replyOptions?.onSessionPrepared;
        if (!prepared) {
          throw new Error("Missing real admission preparation callback");
        }
        prepared(f.scope);
        const claimed = await claimRefreshOperation(f, payload.runId);
        releaseRefresh = claimed.release;
        expect(getRpcSourceProjectSessionActive(claimed.source)).toBe(false);
        expect(getRpcSourceIdentity(claimed.source).sessionId).toBe(f.scope.sessionId);
        await recorder.persistApproved();
        const messages = transcriptMessages(loadTranscriptEventsSync(f.scope));
        expect(messages).toContainEqual(expect.objectContaining({ display: false }));
        expect(JSON.stringify(projectChatDisplayMessages(messages))).not.toContain(
          "Refresh this session",
        );
        releaseRefresh();
        releaseRefresh = undefined;
        await f.finishDispatch();
        expect(() => prepared({ ...f.scope, sessionId: "late-refresh" })).toThrow(
          "no longer owns its admission",
        );
        expect((await progressCardStore.get(f.scope.sessionKey, f.scope.agentId))?.markdown).toBe(
          "Previous status",
        );
        const retry = await refreshCard(f, "refresh-click", undefined, { id: "retry" });
        expect(retry).toHaveBeenCalledWith(...terminalResponse());
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expectNoChat(f);
      } finally {
        releaseRefresh?.();
      }
    },
  );
  it.each([false, true])(
    "steers duplicate active refreshes without answering questions or cancelling work (unconfirmed=%s)",
    async (unconfirmed) => {
      const f = await createFixture({ active: true, preserveContent: true });
      const operation = f.activeRun!;
      const profile = ensureGatewayOwnerProfile("Gateway Owner");
      f.client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
      f.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      const captured = await captureGatewayOperatorRunAuthority({
        client: { ...f.client, connId: "original-owner-connection" },
        context: f.context,
      });
      const run = createQueueTestRun({ prompt: "Continue the original work" });
      run.operatorAuthority = captured?.authority;
      run.run = {
        ...run.run,
        config: f.context.getRuntimeConfig(),
        agentId: f.scope.agentId,
        sessionId: f.scope.sessionId,
        sessionKey: f.scope.sessionKey,
        messageProvider: "webchat",
        chatType: "direct",
        gatewayUiCommandTarget: { connId: "original-owner-connection", profileId: profile.id },
        traceAuthorized: true,
        senderIsOwner: true,
      };
      const cancel = vi.fn();
      const claim = vi.fn(async () => true);
      const steeringAccepted = createDeferredCore();
      const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
        async (_text, options, assertCurrent) => {
          assertCurrent();
          expect(options).toMatchObject({ isInboundUserMessage: false, debounceMs: 0 });
          expect(await options?.userTurnTranscriptRecorder?.resolveMessage()).toMatchObject({
            display: false,
          });
          await options?.userTurnTranscriptRecorder?.persistApproved();
          assertCurrent();
          options?.onQueueAccepted?.(true);
          steeringAccepted.resolve();
          if (unconfirmed) {
            return { transcriptCommit: "unconfirmed", errorMessage: "Receipt still pending" };
          }
          return undefined;
        },
      );
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        supportsTranscriptCommitWait: true,
        runId: "original-work",
        toolAuthorityFingerprint: fingerprint,
        cancel,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          claimPendingUserInputAnswer: claim,
        },
      });
      const visibleProjection = { isControlUiVisible: true, projectSessionMessages: true };
      registerAgentRunContext("original-work", {
        sessionKey: f.scope.sessionKey,
        ...visibleProjection,
      });
      try {
        expect(captured).toBeDefined();
        await putCard(f, "Working");
        const respond = vi.fn<RespondFn>();
        await Promise.all(
          Array.from({ length: 2 }, (_, index) =>
            refreshCard(f, "active-refresh", respond, { id: `refresh-${index}` }),
          ),
        );
        expect(respond.mock.calls).toEqual([acceptedResponse(), acceptedResponse()]);
        const accepted = respond.mock.calls[0]?.[1];
        if (!isRecord(accepted) || typeof accepted.runId !== "string") {
          throw new Error("Missing active refresh acceptance");
        }
        // The ACK precedes native steering; keep its incumbent alive until source settlement.
        await rpcSourceTesting.get(accepted.runId)?.input.settlement.promise;
        expect(claim).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(getAgentRunContext("original-work")).toMatchObject(visibleProjection);
        // The ACK owns input custody; detached steering must reach the active run before it ends.
        await steeringAccepted.promise;
        await f.finishDispatch();
        const retry = await refreshCard(f, "active-refresh", undefined, { id: "retry-steer" });
        expect(retry).toHaveBeenCalledWith(...acceptedResponse());
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(cancel).not.toHaveBeenCalled();
        expectNoChat(f);
      } finally {
        clearAgentRunContext("original-work");
        await f.cleanup();
        captured?.release();
      }
    },
  );
  it("keeps a new human message on its own visible turn while a hidden refresh runs", async () => {
    const f = await createFixture({ active: false, preserveContent: true });
    let releaseHidden: (() => void) | undefined;
    try {
      await putCard(f, "Previous status");
      const respond = await refreshCard(f, "hidden-start", undefined, { id: "hidden-start" });
      const accepted = respond.mock.calls[0]?.[1];
      if (!isRecord(accepted) || typeof accepted.runId !== "string") {
        throw new Error("Missing hidden refresh acceptance");
      }
      await f.dispatchedRecorder;
      const hiddenDispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as Dispatch;
      const prepareHidden = hiddenDispatch.replyOptions?.onSessionPrepared;
      if (!prepareHidden) {
        throw new Error("Missing hidden refresh preparation callback");
      }
      prepareHidden(f.scope);
      const hidden = await claimRefreshOperation(f, accepted.runId);
      releaseHidden = hidden.release;
      const hiddenOperation = hidden.operation;
      hiddenOperation.bindToolAuthoritySnapshot({
        fingerprint: () => "same-authority",
        project: () => "same-authority",
      });
      hiddenOperation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
      const queueMessage = vi.fn(async () => {});
      const claim = vi.fn(async () => false);
      hiddenOperation.attachBackend({
        kind: "embedded",
        supportsTranscriptCommitWait: true,
        runId: accepted.runId,
        toolAuthorityFingerprint: "same-authority",
        cancel: vi.fn(),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          claimPendingUserInputAnswer: claim,
        },
      });
      hiddenOperation.setPhase("running");
      f.params.queueMode = "steer";
      const humanAck = await f.send();
      expect(humanAck).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2));
      expect(queueMessage).not.toHaveBeenCalled();
      expect(claim).toHaveBeenCalledOnce();
      const human = dispatchInboundMessageMock.mock.calls[1]?.[0] as Dispatch;
      expect(human.ctx.InputProvenance).toBeUndefined();
      expect(human.toolsAllow).toBeUndefined();
      expect(
        await human.replyOptions?.userTurnTranscriptRecorder?.resolveMessage(),
      ).not.toHaveProperty("display", false);
      expect(getAgentRunContext(f.params.idempotencyKey)?.projectSessionMessages).not.toBe(false);
      expect(getAgentRunContext(accepted.runId)?.projectSessionMessages).toBe(false);
    } finally {
      releaseHidden?.();
      await f.cleanup();
    }
  });

  it("rejects read-only callers before admitting any turn", async () => {
    await using f = await createFixture({ active: false });
    f.client.connect.scopes = ["operator.read"];
    const respond = await refreshCard(f, "denied");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.write") }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });
});
