import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionRoutingContract } from "../config/sessions/main-session.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createChatAbortOps } from "./chat-abort-ops.js";
import { abortChatRunById } from "./chat-abort.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import { captureChatResult } from "./server.chat-response.test-support.js";
import { dispatchInboundMessageMock } from "./test-helpers.runtime-state.js";

type ChatScope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

export function registerChatAdmissionRetryTests(harness: {
  withCommittedChatSession: (run: (scope: ChatScope) => Promise<void>) => Promise<void>;
  sendControlUiChat: (params: {
    context: GatewayRequestContext;
    expectedSessionRoutingContract?: ReturnType<typeof resolveSessionRoutingContract>;
    idempotencyKey: string;
    message: string;
    respond: RespondFn;
  }) => Promise<void>;
}) {
  test.each([
    { caseName: "tombstones an explicit abort", retryable: false, stopReason: "rpc" },
    { caseName: "retains a restart interruption", retryable: true, stopReason: "restart" },
  ])("chat.send $caseName after SQLite admission commits", async ({ retryable, stopReason }) => {
    const runId = `idem-restart-safe-abort-${stopReason}`;
    const send = async (context: GatewayRequestContext) => {
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      await harness.sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "persist, then stop",
        respond: captureChatResult(responses),
      });
      return responses;
    };
    const userInput = (event: unknown) =>
      isRecord(event) &&
      event.type === "message" &&
      isRecord(event.message) &&
      event.message.idempotencyKey === `${runId}:user`;
    let stopListening: (() => void) | undefined;
    await harness.withCommittedChatSession(async (scope) => {
      try {
        const context = createDirectChatContext();
        const abortCommittedTurn = vi.fn(() => {
          const activeRun = expectDefined(
            rpcSourceTesting.get(runId),
            "expected admitted chat run",
          );
          if (retryable) {
            activeRun.adapter.abortStopReason = stopReason;
            requestRpcSourceCancellation(activeRun);
          } else {
            expect(
              abortChatRunById(createChatAbortOps(context), {
                runId,
                sessionKey: scope.sessionKey,
                expectedEntry: activeRun,
                stopReason,
              }),
            ).toEqual({ aborted: true });
          }
        });
        // The transcript notification follows the atomic user-turn and recovery-claim commit.
        stopListening = onSessionTranscriptUpdate((update) => {
          if (
            update.target.sessionKey === scope.sessionKey &&
            update.target.sessionId === scope.sessionId &&
            isRecord(update.message) &&
            update.message.role === "user" &&
            update.message.idempotencyKey === `${runId}:user`
          ) {
            abortCommittedTurn();
          }
        });
        const responses = await send(context);
        stopListening();
        expect(abortCommittedTurn).toHaveBeenCalledOnce();
        expect(responses).toEqual([
          {
            ok: true,
            payload: expect.objectContaining({
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason,
            }),
          },
        ]);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        const stored = loadSessionEntry(scope);
        expect(stored).toMatchObject({
          abortedLastRun: !retryable,
          lastRunId: runId,
          sessionId: "sess-main",
          status: "killed",
        });
        expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
        if (retryable) {
          expect(stored?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
          expect(stored?.restartRecoveryDeliveryRequestFingerprint).toEqual(
            expect.stringMatching(/^hmac-sha256:v1:/u),
          );
          expect(stored?.restartRecoveryDeliveryRunId).toBe(runId);
          expect(stored?.restartRecoveryDeliverySourceRunId).toBe(runId);
          expect(stored?.restartRecoverySourceIngress).toBe("control-ui");
          expect(stored?.restartRecoveryTerminalRunIds).toBeUndefined();
        } else {
          expect(stored?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
          expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
          expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
          expect(stored?.restartRecoverySourceIngress).toBeUndefined();
          expect(stored?.restartRecoveryTerminalRunIds).toEqual([runId]);
          expect(context.chatRunState.hasAbortMarker(runId)).toBe(true);
          expect(context.dedupe.delete(`chat:${runId}`)).toBe(true);
          const abortedRetryResponses = await send(context);
          expect(abortedRetryResponses).toEqual([
            {
              ok: true,
              payload: expect.objectContaining({ runId, status: "timeout", summary: "aborted" }),
            },
          ]);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        }
        expect(loadTranscriptEventsSync(scope)).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: "persist, then stop",
              idempotencyKey: `${runId}:user`,
              role: "user",
            }),
          }),
        );

        const retryContext = createDirectChatContext();
        dispatchInboundMessageMock.mockResolvedValue({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        });
        const retryResponses = await send(retryContext);
        expect(retryResponses).toEqual([
          {
            ok: true,
            payload: retryable
              ? expect.objectContaining({ runId, status: "started", messageSeq: 1 })
              : { runId, status: "ok", messageSeq: 1 },
          },
        ]);
        await captureSessionControllerSettlement({
          scope: scope.storePath,
          identities: [scope.sessionKey, scope.sessionId],
        });
        expect(retryContext.removeChatRun).toHaveBeenCalledTimes(retryable ? 1 : 0);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(retryable ? 1 : 0);
        if (!retryable) {
          expect(loadSessionEntry(scope)).toEqual(stored);
        }
        expect(loadTranscriptEventsSync(scope).filter(userInput)).toHaveLength(1);
      } finally {
        stopListening?.();
      }
    });
  });

  test("chat.send resumes failed dispatch custody without duplicating recorded input", async () => {
    const runId = "idem-restart-safe-dispatch-error";
    await harness.withCommittedChatSession(async (scope) => {
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch rejected"));

      await harness.sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await captureSessionControllerSettlement({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      const failed = loadSessionEntry(scope);
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const collisionContext = createDirectChatContext();
      const collisionResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      await harness.sendControlUiChat({
        context: collisionContext,
        idempotencyKey: runId,
        message: "changed text under the same run id",
        respond: captureChatResult(collisionResponses),
      });
      expect(collisionResponses).toEqual([
        {
          ok: false,
          payload: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry(scope)).toMatchObject({
        abortedLastRun: false,
        status: "failed",
      });

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      await harness.sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started", messageSeq: 1 }),
        },
      ]);
      await captureSessionControllerSettlement({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      expect(retryContext.removeChatRun).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(
        loadTranscriptEventsSync(scope).filter(
          (event) =>
            isRecord(event) &&
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.idempotencyKey === `${runId}:user`,
        ),
      ).toHaveLength(1);
    });
  });

  test("chat.send resumes failed routing custody without duplicating recorded input", async () => {
    const runId = "idem-restart-safe-routing-change";
    await harness.withCommittedChatSession(async (scope) => {
      const context = createDirectChatContext();
      const initialRuntimeConfig = getRuntimeConfig();
      const changedRuntimeConfig = {
        ...initialRuntimeConfig,
        session: {
          ...initialRuntimeConfig.session,
          scope: initialRuntimeConfig.session?.scope === "global" ? "per-sender" : "global",
        },
      } as const;
      context.getRuntimeConfig = () =>
        loadSessionEntry(scope)?.restartRecoveryDeliveryRunId === runId
          ? changedRuntimeConfig
          : initialRuntimeConfig;
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await harness.sendControlUiChat({
        context,
        expectedSessionRoutingContract: resolveSessionRoutingContract(initialRuntimeConfig),
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([{ ok: false, payload: undefined }]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const failed = loadSessionEntry(scope);
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValue({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      await harness.sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started", messageSeq: 1 }),
        },
      ]);
      await captureSessionControllerSettlement({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
      });
      expect(retryContext.removeChatRun).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(
        loadTranscriptEventsSync(scope).filter(
          (event) =>
            isRecord(event) &&
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.idempotencyKey === `${runId}:user`,
        ),
      ).toHaveLength(1);
    });
  });
}
