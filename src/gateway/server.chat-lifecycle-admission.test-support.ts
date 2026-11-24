import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { isRpcSourceQueued } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import { callDirectChat } from "./server.chat-direct-handler.test-support.js";
import {
  captureChatResponse,
  type CapturedChatResponse,
} from "./server.chat-response.test-support.js";
import {
  holdSessionMutation,
  writeStoredMainSession,
} from "./server.chat-session-store.test-support.js";
import { dispatchInboundMessageMock } from "./test-helpers.js";

type ChatSendParams = Record<string, unknown> & { idempotencyKey: string };
type ChatLifecycleFixtures = {
  openDirectChatSession: () => { storePath: string };
  requestChat: (
    method: Parameters<typeof callDirectChat>[0],
    context: GatewayRequestContext,
    params: Record<string, unknown>,
    options?: Pick<Parameters<typeof callDirectChat>[1], "client">,
  ) => Promise<CapturedChatResponse[]>;
  makeChatSendParams: (overrides: ChatSendParams) => ChatSendParams;
  makeMainSessionParams: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  chatResponse: (
    ok: boolean,
    payload: unknown,
    error?: unknown,
  ) => {
    ok: boolean;
    payload: unknown;
    error: unknown;
  };
  resetDirectChatSession: () => Promise<void>;
};

const FAST_WAIT_OPTS = { timeout: 2_000, interval: 1 } as const;
function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function startPendingChat(
  context: GatewayRequestContext,
  params: ChatSendParams,
  options: Pick<Parameters<typeof callDirectChat>[1], "client"> & { id?: string } = {},
) {
  const responses: CapturedChatResponse[] = [];
  const send = callDirectChat("chat.send", {
    id: "send",
    ...options,
    params,
    context,
    respond: captureChatResponse(responses),
  });
  const waitForPending = () =>
    waitForFast(() => {
      expect(context.dedupe.has(pendingChatSendDedupeKey(params.idempotencyKey))).toBe(true);
    }, FAST_WAIT_OPTS);
  return { send, responses, waitForPending };
}

export function registerChatLifecycleAdmissionTests({
  openDirectChatSession,
  requestChat,
  makeChatSendParams,
  makeMainSessionParams,
  chatResponse,
  resetDirectChatSession,
}: ChatLifecycleFixtures) {
  test("chat.abort cancels chat.send while lifecycle admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    const pending: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
    await runQaGatewayFixture(
      async () => {
        await writeStoredMainSession({});
        const { mutation, started } = holdSessionMutation(storePath, releaseMutation);
        pending.push(Promise.allSettled([mutation]));
        await started;

        const context = createDirectChatContext();
        const runId = "idem-lifecycle-wait-abort";
        const collidingFinalKey = `chat:pending:${runId}`;
        const collidingFinalEntry = {
          ts: Date.now(),
          ok: true,
          payload: { runId: `pending:${runId}`, status: "ok" },
        };
        context.dedupe.set(collidingFinalKey, collidingFinalEntry);
        const params = makeChatSendParams({ message: "do not dispatch", idempotencyKey: runId });
        const client = {
          connId: "conn-owner",
          connect: { device: { id: "dev-owner" }, scopes: ["operator.write"] },
        } as never;
        const {
          send,
          responses: sendResponses,
          waitForPending,
        } = startPendingChat(context, params, {
          client,
        });
        pending.push(Promise.allSettled([send]));
        await waitForPending();
        expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
        expect(isRpcSourceQueued(rpcSourceTesting.get(runId))).toBe(true);

        const retryResponses = await requestChat("chat.send", context, params, { client });
        expect(retryResponses).toEqual([
          chatResponse(false, undefined, {
            code: "UNAVAILABLE",
            message: "Chat input is being admitted; retry the same request.",
            retryable: true,
          }),
        ]);
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);

        const abortResponses = await requestChat(
          "chat.abort",
          context,
          makeMainSessionParams({ runId }),
          { client },
        );
        releaseMutation.resolve();
        await mutation;
        await send;

        expect(abortResponses).toEqual([
          chatResponse(true, { ok: true, aborted: true, runIds: [runId] }),
        ]);
        expect(sendResponses).toEqual([
          chatResponse(true, {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          }),
        ]);
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
        expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
        expect(rpcSourceTesting.has(runId)).toBe(false);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      },
      async () => {
        releaseMutation.resolve();
        throwIfSettledRejected(
          (await Promise.all(pending)).flat(),
          "Pending chat fixture work failed",
        );
      },
      resetDirectChatSession,
    );
  });

  test.each(["restart", "reset"] as const)(
    "chat.send rejects %s replacement while lifecycle admission waits",
    async (replacement) => {
      const { storePath } = openDirectChatSession();
      const releaseMutation = createDeferred();
      const pending: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
      await runQaGatewayFixture(
        async () => {
          await writeStoredMainSession({ sessionId: "sess-main" });
          const { mutation, started } = holdSessionMutation(storePath, releaseMutation, {
            ...(replacement === "reset" ? { kind: "reset" } : {}),
            identities: ["agent:main:main", "sess-main"],
          });
          pending.push(Promise.allSettled([mutation]));
          await started;
          const context = createDirectChatContext();
          const runId = `idem-${replacement}-lifecycle`;
          const { send, responses, waitForPending } = startPendingChat(
            context,
            makeChatSendParams({
              message: "do not enter replacement work",
              idempotencyKey: runId,
            }),
          );
          pending.push(Promise.allSettled([send]));
          await waitForPending();
          if (replacement === "restart") {
            rotateAgentEventLifecycleGeneration();
          } else {
            await writeStoredMainSession({ sessionId: "sess-after-reset" });
          }
          releaseMutation.resolve();
          await mutation;
          await send;
          if (replacement === "restart") {
            expect(responses).toEqual([
              chatResponse(true, {
                runId,
                status: "timeout",
                summary: "aborted",
                stopReason: "restart",
                endedAt: expect.any(Number),
              }),
            ]);
            expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
          } else {
            expect(responses).toHaveLength(1);
            expect(responses[0]?.ok).toBe(false);
            expect(responses[0]?.error).toMatchObject({
              message: expect.stringMatching(/changed while starting work/i),
            });
          }
          expect(rpcSourceTesting.has(runId)).toBe(false);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        },
        async () => {
          releaseMutation.resolve();
          throwIfSettledRejected(
            (await Promise.all(pending)).flat(),
            "Pending chat fixture work failed",
          );
        },
        resetDirectChatSession,
      );
    },
  );
}
