import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForGatewayDispatch } from "../../gateway/server-in-process-dispatch.js";
import { createDeferredCore as createDeferred } from "../../shared/deferred.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import { queueEmbeddedAgentMessageWithOutcomeAsync } from "../embedded-agent-runner/runs.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";

vi.mock("../../sessions/user-turn-transcript.js", () => ({
  buildRunUserTurnIdempotencyKey: (id: string) => `${id}:user`,
  createUserTurnTranscriptRecorder: vi.fn(),
}));
vi.mock("../embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(),
}));
vi.mock("../embedded-agent-runner/runs.js", () => ({
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(),
  formatEmbeddedAgentQueueFailureSummary: vi.fn(),
}));

const target = "agent:main:cron:job:run:old";

describe("sessions_send uncertain dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it.each([false, true])(
    "retains the dispatched identity after a deadline (Cron fallback %s)",
    async (fallback) => {
      vi.useFakeTimers();
      vi.mocked(resolveActiveEmbeddedRunSessionId).mockReturnValue(fallback ? "active" : undefined);
      vi.mocked(queueEmbeddedAgentMessageWithOutcomeAsync).mockResolvedValue({
        queued: false,
        reason: "no_active_run",
        sessionId: "active",
        gatewayHealth: "live",
      });
      const operation = createDeferred<{ runId: string }>();
      const dispatched = createDeferred();
      let accepted = false;
      const requests: Parameters<AgentToolGatewayRequestCaller>[0][] = [];
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => {
        requests.push(request);
        const response = waitForGatewayDispatch(
          request.method,
          operation.promise.then((value) => {
            accepted = true;
            return value;
          }),
          request.timeoutMs ?? undefined,
        );
        dispatched.resolve();
        return (await response) as T;
      };
      const send = startSessionsSendAgentRun({
        cfg: {},
        callGateway,
        runId: "original",
        sessionKey: target,
        sessionStoreTarget: { agentId: "main", canonicalKey: target, storePath: "/fixture/store" },
        allowActiveRunQueueDelivery: true,
        sendParams: {
          message: "Continue once",
          agentId: "main",
          sessionKey: target,
          idempotencyKey: "original",
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:main",
            sourceTool: "sessions_send",
          },
        },
      });
      await dispatched.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await send;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected unconfirmed dispatch");
      }
      const request = requests[0];
      expect(request).toBeDefined();
      const sentParams = request?.params as { idempotencyKey: string };
      expect(sentParams.idempotencyKey).toEqual(fallback ? expect.any(String) : "original");
      if (fallback) {
        expect(sentParams.idempotencyKey).not.toBe("original");
      }
      expect(result.result.details).toMatchObject({
        status: "error",
        sessionKey: fallback ? "agent:main:cron:job" : target,
        runId: sentParams.idempotencyKey,
        dispatch: {
          outcome: "unknown",
          code: "CLIENT_TIMEOUT",
          requestSent: true,
          timeoutMs: 10_000,
          idempotencyKey: sentParams.idempotencyKey,
        },
        error: expect.stringMatching(/unconfirmed.*before retrying/),
      });
      expect(result.result.details).not.toHaveProperty("sentBeforeError");
      expect(accepted).toBe(false);
      operation.resolve({ runId: "late-run" });
      await operation.promise;
      expect(accepted).toBe(true);
      expect(requests).toHaveLength(1);
    },
  );
});
