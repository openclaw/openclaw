import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "../../agents/run-termination.js";
import { interruptSessionControllerEffects } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import { setupRestartRecoveryAdmissionFixture } from "./agent.pre-dispatch-failure.test-utils.js";
import {
  backendGatewayClient,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  requireValue,
  waitForAssertion,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";

const mocks = getAgentTestMocks();

export function registerAgentQueuedRestartRecoveryTests() {
  it.each(["rpc", "stop", "interrupt", "restart", "timeout"] as const)(
    "settles queued restart recovery after %s without reviving explicit cancellation",
    async (cause) => {
      const runId = `queued-recovery-${cause}`;
      const { sessionKey, sessionId, storePath, store } =
        setupRestartRecoveryAdmissionFixture(runId);
      const dispatchGate = createDeferred();
      const dispatchYield = vi
        .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
        .mockReturnValue(dispatchGate.promise);
      const context = makeContext();
      const respond = vi.fn();
      const stopRespond = vi.fn();
      let cancellation: Promise<unknown> | undefined;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await invokeAgent(
          {
            message: "resume after restart",
            agentId: "main",
            sessionKey,
            sessionId,
            expectedExistingSessionId: sessionId,
            idempotencyKey: runId,
            timeout: cause === "timeout" ? 1 : 120,
            inputProvenance: {
              kind: "internal_system",
              sourceSessionKey: sessionKey,
              sourceTool: "main_session_restart_recovery",
            },
          },
          { context, client: backendGatewayClient(), reqId: runId, respond, flushDispatch: false },
        );
        const active = requireValue(rpcSourceTesting.get(runId), "queued recovery source missing");
        expectRecordFields(respond.mock.calls[0]?.[1], { runId, status: "accepted" });
        expect(store[sessionKey]?.abortedLastRun).toBe(false);
        expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
        expect(mocks.agentCommand).not.toHaveBeenCalled();

        if (cause === "rpc") {
          cancellation = handleChatAbortRequest({
            params: { sessionKey, runId },
            respond: vi.fn(),
            context,
            req: { type: "req", id: `${runId}-abort`, method: "chat.abort" },
            client: null,
            isWebchatConnect: () => false,
          });
        } else if (cause === "stop") {
          cancellation = handleDirectExternalChatSend({
            params: { sessionKey, message: "/stop", idempotencyKey: `${runId}-stop` },
            respond: stopRespond,
            context,
            req: { type: "req", id: `${runId}-stop`, method: "chat.send" },
            client: null,
            isWebchatConnect: () => false,
          });
        } else if (cause === "timeout") {
          cancellation = vi.advanceTimersByTimeAsync(1_000);
        } else {
          cancellation = interruptSessionControllerEffects({
            scope: storePath,
            identities: [sessionKey, sessionId],
            reason:
              cause === "restart"
                ? createAgentRunRestartAbortError()
                : createAgentRunDirectAbortError(),
          });
        }
        void cancellation.catch(() => {});
        await waitForAssertion(() => {
          expect(
            stopRespond.mock.lastCall?.[0],
            JSON.stringify(stopRespond.mock.lastCall),
          ).not.toBe(false);
          expect(active.input.abortSignal.aborted).toBe(true);
        });
        dispatchGate.resolve();
        await cancellation;
        await active.input.settlement.promise;

        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(rpcSourceTesting.has(runId)).toBe(false);
        const retryable = cause === "restart" || cause === "timeout";
        expect(store[sessionKey]).toMatchObject({
          sessionId,
          status: retryable ? "interrupted" : "killed",
          abortedLastRun: retryable,
        });
        expect(store[sessionKey]?.restartRecoveryDeliveryRunId).toBeUndefined();
        if (retryable) {
          expect(store[sessionKey]?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
          expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
          expect(store[sessionKey]?.restartRecoveryDeliverySourceRunId).toBe(
            "interrupted-source-run",
          );
        } else {
          expect(store[sessionKey]?.mainRestartRecovery).toBeUndefined();
          expect(store[sessionKey]?.restartRecoveryRuns).toBeUndefined();
        }
      } finally {
        dispatchGate.resolve();
        await cancellation?.catch(() => {});
        dispatchYield.mockRestore();
        vi.useRealTimers();
      }
    },
  );
}
