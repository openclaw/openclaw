import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import {
  getAgentRunContext,
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { projectChatDisplayMessages } from "../chat-display-projection.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { progressCardStore } from "../progress-card-store.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

describe("registered progress refresh admission", () => {
  it.each([false, true])(
    "reconciles a completed retry under current authority (revoke=%s)",
    async (revoke) => {
      const owner = revoke ? roleClient("view", "refresh-session-owner") : undefined;
      const caller = revoke ? roleClient("write", "refresh-requester") : undefined;
      const f = await createFixture({
        active: false,
        preserveContent: true,
        ...(owner
          ? {
              createdActor: {
                type: "human",
                source: "profile",
                id: owner.authenticatedUserProfile!.profileId,
              },
            }
          : {}),
      });
      if (caller) {
        const cfg = { ...f.context.getRuntimeConfig(), ...rolePolicyConfig() };
        f.context.getRuntimeConfig = () => cfg;
      }
      const cardRead = createDeferredCore();
      const releaseRead = createDeferredCore();
      const handlers = createProgressCardHandlers();
      let readingTerminalCard = false;
      let revoked = false;
      let assertCurrentAuthorization: (() => void) | undefined;
      const refresh = async (respond: RespondFn) =>
        handleGatewayRequest({
          req: {
            type: "req",
            id: "refresh",
            method: "progressCard.refresh",
            params: { sessionKey: f.scope.sessionKey, idempotencyKey: "finishing-refresh" },
          },
          client: caller ?? f.client,
          context: f.context,
          respond,
          isWebchatConnect: () => true,
          extraHandlers: {
            ...handlers,
            "progressCard.refresh": async (invocation) => {
              if (caller) {
                const authorization = invocation.sessionMutationAuthorization!;
                const assertCurrent = authorization.assertCurrent.bind(authorization);
                assertCurrentAuthorization = assertCurrent;
                authorization.assertCurrent = () => {
                  assertCurrent();
                  if (readingTerminalCard) {
                    readingTerminalCard = false;
                    // Revoke after the reader's check, before its caller resumes to publish.
                    queueMicrotask(() => {
                      setUserProfileRole(caller.authenticatedUserProfile!.profileId, "view");
                      invalidateOperatorRolePolicy(caller.authenticatedUserProfile!.profileId);
                      revoked = true;
                    });
                  }
                };
              }
              await handlers["progressCard.refresh"]!(invocation);
            },
          },
        });
      try {
        await progressCardStore.put(
          f.scope.sessionKey,
          { markdown: "Old status" },
          f.scope.agentId,
        );
        const accepted = vi.fn<RespondFn>();
        await refresh(accepted);
        expect(accepted).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "accepted", revision: 1 }),
          undefined,
          expect.anything(),
        );
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
          await progressCardStore.put(
            f.scope.sessionKey,
            { markdown: "Fresh status" },
            f.scope.agentId,
          );
          await f.finishDispatch();
          releaseRead.resolve();
          await pending;
          if (revoke) {
            expect(revoked).toBe(true);
            expect(assertCurrentAuthorization).toThrow("session is shared for this connection");
            expect(f.context.dedupe.get(receipt![0])).toBe(receipt![1]);
            expect(retry).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
              }),
            );
          } else {
            expect(retry).toHaveBeenCalledExactlyOnceWith(
              true,
              expect.objectContaining({ status: "accepted", revision: 1 }),
              undefined,
              expect.anything(),
            );
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
  it.each([1, 2])(
    "deduplicates concurrent refresh bursts with %i distinct intents through completion",
    async (intentCount) => {
      const f = await createFixture({ active: false, preserveContent: true });
      const dispatched = createDeferredCore();
      const dispatch = dispatchInboundMessageMock.getMockImplementation()!;
      dispatchInboundMessageMock.mockImplementation((...args) => {
        const result = dispatch(...args);
        if (dispatchInboundMessageMock.mock.calls.length === intentCount) {
          dispatched.resolve();
        }
        return result;
      });
      const refresh = async (idempotencyKey: string) => {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "refresh",
            method: "progressCard.refresh",
            params: { sessionKey: f.scope.sessionKey, idempotencyKey },
          },
          client: f.client,
          context: f.context,
          respond,
          isWebchatConnect: () => true,
          extraHandlers: createProgressCardHandlers(),
        });
        return respond;
      };
      const burst = () =>
        Promise.all(
          Array.from({ length: 2 * intentCount }, (_, index) =>
            refresh(`burst-${index % intentCount}`),
          ),
        );
      const expectAccepted = (responses: Awaited<ReturnType<typeof burst>>) => {
        const runIds = new Set<unknown>();
        for (const response of responses) {
          expect(response).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({ status: "accepted", revision: 1 }),
            undefined,
            expect.anything(),
          );
          const payload = response.mock.calls[0]?.[1];
          expect(payload).toHaveProperty("runId", expect.any(String));
          runIds.add(isRecord(payload) ? payload.runId : undefined);
        }
        expect(runIds.size).toBe(intentCount);
      };
      try {
        await progressCardStore.put(
          f.scope.sessionKey,
          { markdown: "Old status" },
          f.scope.agentId,
        );
        expectAccepted(await burst());
        await dispatched.promise;
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(intentCount);
        for (const [params] of dispatchInboundMessageMock.mock.calls) {
          const admitted = params as Parameters<typeof dispatchInboundMessage>[0];
          expect(admitted.toolsAllow).toContain("progress_card");
          expect(admitted.toolsAllow).not.toContain("exec");
          await admitted.replyOptions?.userTurnTranscriptRecorder?.persistApproved();
        }
        await f.finishDispatch();
        for (const response of await burst()) {
          expect(response).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } }),
            expect.anything(),
          );
        }
        await progressCardStore.put(
          f.scope.sessionKey,
          { markdown: "Current status" },
          f.scope.agentId,
        );
        expectAccepted(await burst());
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(intentCount);
        const messages = loadTranscriptEventsSync(f.scope).flatMap((row) =>
          isRecord(row) && isRecord(row.message) ? [row.message] : [],
        );
        expect(messages.filter((message) => message.display === false)).toHaveLength(intentCount);
        expect(projectChatDisplayMessages(messages)).toEqual(
          projectChatDisplayMessages(
            f.activeTranscript.flatMap((row) =>
              isRecord(row) && isRecord(row.message) ? [row.message] : [],
            ),
          ),
        );
        expect(
          vi.mocked(f.context.broadcast).mock.calls.filter(([event]) => event === "chat"),
        ).toHaveLength(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each([false, true])(
    "starts a hidden status-only turn when idle or steering is unavailable (active=%s)",
    async (active) => {
      const f = await createFixture({ active, preserveContent: true });
      try {
        await progressCardStore.put(
          f.scope.sessionKey,
          { markdown: "Previous status" },
          f.scope.agentId,
        );
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "refresh",
            method: "progressCard.refresh",
            params: { sessionKey: f.scope.sessionKey, idempotencyKey: "refresh-click" },
          },
          client: f.client,
          context: f.context,
          respond,
          isWebchatConnect: () => true,
          extraHandlers: createProgressCardHandlers(),
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "accepted", revision: 1 }),
          undefined,
          expect.anything(),
        );
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
        expect(f.context.chatAbortControllers.get(payload.runId)).toMatchObject({
          controlUiVisible: false,
          projectSessionActive: false,
        });
        const dispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as Parameters<
          typeof dispatchInboundMessage
        >[0];
        expect(dispatch.ctx.InternalTurnSource).toBe("progress-card-refresh");
        expect(dispatch.ctx.InputProvenance).toMatchObject({ sourceTool: "progress_card_refresh" });
        expect(dispatch.toolsAllow).toContain("progress_card");
        expect(dispatch.toolsAllow).not.toContain("exec");
        const prepared = dispatch.replyOptions?.onSessionPrepared;
        if (!prepared) {
          throw new Error("Missing real admission preparation callback");
        }
        prepared({
          sessionKey: f.scope.sessionKey,
          sessionId: f.scope.sessionId,
          storePath: f.scope.storePath,
        });
        expect(f.context.chatAbortControllers.get(payload.runId)?.sessionId).toBe(
          f.scope.sessionId,
        );
        await recorder.persistApproved();
        const rows = loadTranscriptEventsSync(f.scope);
        const messages = rows.flatMap((row) =>
          isRecord(row) && isRecord(row.message) ? [row.message] : [],
        );
        expect(messages).toContainEqual(expect.objectContaining({ display: false }));
        expect(JSON.stringify(projectChatDisplayMessages(messages))).not.toContain(
          "Refresh this session",
        );
        await f.finishDispatch();
        expect(() =>
          prepared({
            sessionKey: f.scope.sessionKey,
            sessionId: "late-refresh",
            storePath: f.scope.storePath,
          }),
        ).toThrow("no longer owns its admission");
        expect((await progressCardStore.get(f.scope.sessionKey, f.scope.agentId))?.markdown).toBe(
          "Previous status",
        );
        const retry = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "retry",
            method: "progressCard.refresh",
            params: { sessionKey: f.scope.sessionKey, idempotencyKey: "refresh-click" },
          },
          client: f.client,
          context: f.context,
          respond: retry,
          isWebchatConnect: () => true,
          extraHandlers: createProgressCardHandlers(),
        });
        expect(retry).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } }),
          expect.anything(),
        );
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(
          vi.mocked(f.context.broadcast).mock.calls.filter(([event]) => event === "chat"),
        ).toHaveLength(0);
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each([false, true])(
    "steers duplicate active refreshes without answering questions or cancelling work (unconfirmed=%s)",
    async (unconfirmed) => {
      const f = await createFixture({ active: true, preserveContent: true });
      const operation = f.activeRun!;
      const cancel = vi.fn();
      const claim = vi.fn(async () => true);
      const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
        async (_text, options, assertCurrent) => {
          assertCurrent();
          expect(options?.isInboundUserMessage).toBe(false);
          expect(options?.debounceMs).toBe(0);
          expect(await options?.userTurnTranscriptRecorder?.resolveMessage()).toMatchObject({
            display: false,
          });
          await options?.userTurnTranscriptRecorder?.persistApproved();
          assertCurrent();
          options?.onQueueAccepted?.(true);
          if (unconfirmed) {
            return { transcriptCommit: "unconfirmed", errorMessage: "Receipt still pending" };
          }
          return undefined;
        },
      );
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => "same-authority",
        project: () => "same-authority",
      });
      operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        runId: "original-work",
        toolAuthorityFingerprint: "same-authority",
        cancel,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage,
          claimPendingUserInputAnswer: claim,
        },
      });
      registerAgentRunContext("original-work", {
        sessionKey: f.scope.sessionKey,
        isControlUiVisible: true,
        projectSessionMessages: true,
      });
      try {
        await progressCardStore.put(f.scope.sessionKey, { markdown: "Working" }, f.scope.agentId);
        const respond = vi.fn<RespondFn>();
        await Promise.all(
          Array.from({ length: 2 }, (_, index) =>
            handleGatewayRequest({
              req: {
                type: "req",
                id: `refresh-${index}`,
                method: "progressCard.refresh",
                params: { sessionKey: f.scope.sessionKey, idempotencyKey: "active-refresh" },
              },
              client: f.client,
              context: f.context,
              respond,
              isWebchatConnect: () => true,
              extraHandlers: createProgressCardHandlers(),
            }),
          ),
        );
        expect(respond).toHaveBeenCalledTimes(2);
        for (const call of respond.mock.calls) {
          expect(call).toEqual([
            true,
            expect.objectContaining({ status: "accepted", revision: 1 }),
            undefined,
            expect.anything(),
          ]);
        }
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(claim).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(getAgentRunContext("original-work")).toMatchObject({
          isControlUiVisible: true,
          projectSessionMessages: true,
        });
        await f.finishDispatch();
        const retry = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "retry-steer",
            method: "progressCard.refresh",
            params: { sessionKey: f.scope.sessionKey, idempotencyKey: "active-refresh" },
          },
          client: f.client,
          context: f.context,
          respond: retry,
          isWebchatConnect: () => true,
          extraHandlers: createProgressCardHandlers(),
        });
        expect(retry).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "accepted", revision: 1 }),
          undefined,
          expect.anything(),
        );
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(cancel).not.toHaveBeenCalled();
        expect(
          vi.mocked(f.context.broadcast).mock.calls.filter(([event]) => event === "chat"),
        ).toHaveLength(0);
      } finally {
        clearAgentRunContext("original-work");
        await f.cleanup();
      }
    },
  );
  it("keeps a new human message on its own visible turn while a hidden refresh runs", async () => {
    const f = await createFixture({ active: false, preserveContent: true });
    let hiddenOperation: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await progressCardStore.put(
        f.scope.sessionKey,
        { markdown: "Previous status" },
        f.scope.agentId,
      );
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "hidden-start",
          method: "progressCard.refresh",
          params: { sessionKey: f.scope.sessionKey, idempotencyKey: "hidden-start" },
        },
        client: f.client,
        context: f.context,
        respond,
        isWebchatConnect: () => true,
        extraHandlers: createProgressCardHandlers(),
      });
      const accepted = respond.mock.calls[0]?.[1];
      if (!isRecord(accepted) || typeof accepted.runId !== "string") {
        throw new Error("Missing hidden refresh acceptance");
      }
      await f.dispatchedRecorder;
      hiddenOperation = createReplyOperation({ ...f.scope, resetTriggered: false });
      hiddenOperation.bindToolAuthoritySnapshot({
        fingerprint: () => "same-authority",
        project: () => "same-authority",
      });
      hiddenOperation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
      const queueMessage = vi.fn(async () => {});
      const claim = vi.fn(async () => false);
      hiddenOperation.attachBackend({
        kind: "embedded",
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
      const human = dispatchInboundMessageMock.mock.calls[1]?.[0] as Parameters<
        typeof dispatchInboundMessage
      >[0];
      expect(human.ctx.InputProvenance).toBeUndefined();
      expect(human.toolsAllow).toBeUndefined();
      expect(
        await human.replyOptions?.userTurnTranscriptRecorder?.resolveMessage(),
      ).not.toHaveProperty("display", false);
      expect(getAgentRunContext(f.params.idempotencyKey)?.projectSessionMessages).not.toBe(false);
      expect(getAgentRunContext(accepted.runId)?.projectSessionMessages).toBe(false);
    } finally {
      hiddenOperation?.complete();
      await f.cleanup();
    }
  });

  it("rejects read-only callers before admitting any turn", async () => {
    const f = await createFixture({ active: false });
    try {
      f.client.connect.scopes = ["operator.read"];
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "refresh",
          method: "progressCard.refresh",
          params: { sessionKey: f.scope.sessionKey, idempotencyKey: "denied" },
        },
        client: f.client,
        context: f.context,
        respond,
        isWebchatConnect: () => true,
        extraHandlers: createProgressCardHandlers(),
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("operator.write") }),
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
});
