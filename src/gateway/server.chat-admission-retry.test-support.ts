import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
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
    idempotencyKey: string;
    message: string;
    respond: RespondFn;
  }) => Promise<void>;
}) {
  const send = async (context: GatewayRequestContext, runId: string, message: string) => {
    const responses: Array<{ ok: boolean; payload?: unknown }> = [];
    await harness.sendControlUiChat({
      context,
      idempotencyKey: runId,
      message,
      respond: captureChatResult(responses),
    });
    return responses;
  };
  const settle = (scope: ChatScope) =>
    captureSessionControllerSettlement({
      scope: scope.storePath,
      identities: [scope.sessionKey, scope.sessionId],
    });
  const expectOneInput = (scope: ChatScope, runId: string) => {
    expect(
      loadTranscriptEventsSync(scope).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.idempotencyKey === `${runId}:user`,
      ),
    ).toHaveLength(1);
  };

  test("chat.send honors an explicit abort after SQLite input admission commits", async () => {
    const runId = "idem-admission-committed-abort";
    await harness.withCommittedChatSession(async (scope) => {
      const context = createDirectChatContext();
      const abortCommittedTurn = vi.fn(() => {
        const activeRun = expectDefined(rpcSourceTesting.get(runId), "expected admitted chat run");
        expect(
          abortChatRunById(createChatAbortOps(context), {
            runId,
            sessionKey: scope.sessionKey,
            expectedEntry: activeRun,
            stopReason: "rpc",
          }),
        ).toEqual({ aborted: true });
      });
      // The notification follows the atomic user-turn commit, before dispatch.
      const stopListening = onSessionTranscriptUpdate((update) => {
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
      try {
        const responses = await send(context, runId, "persist, then stop");
        stopListening();
        expect(abortCommittedTurn).toHaveBeenCalledOnce();
        expect(responses).toEqual([
          {
            ok: true,
            payload: expect.objectContaining({
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "rpc",
            }),
          },
        ]);
        await settle(scope);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toMatchObject({
          abortedLastRun: true,
          lastRunId: runId,
          sessionId: "sess-main",
          status: "killed",
        });
        expect(context.chatRunState.hasAbortMarker(runId)).toBe(true);
        expect(await send(context, runId, "persist, then stop")).toEqual([
          {
            ok: true,
            payload: expect.objectContaining({ runId, status: "timeout", summary: "aborted" }),
          },
        ]);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expectOneInput(scope, runId);
      } finally {
        stopListening();
      }
    });
  });

  test("chat.send records a dispatch failure after its input commits", async () => {
    const runId = "idem-admission-dispatch-error";
    await harness.withCommittedChatSession(async (scope) => {
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch rejected"));
      const responses = await send(context, runId, "retain this accepted input");
      expect(responses).toEqual([
        { ok: true, payload: expect.objectContaining({ runId, status: "started" }) },
      ]);
      await settle(scope);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(loadSessionEntry(scope)).toMatchObject({ abortedLastRun: false, status: "failed" });
      expectOneInput(scope, runId);
    });
  });
}
