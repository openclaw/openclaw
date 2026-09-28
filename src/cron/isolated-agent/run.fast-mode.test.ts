import { describe, expect, it, vi } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  callGatewayMock,
  dispatchCronDeliveryMock,
  retireSessionMcpRuntimeMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — session cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("deletes the run-scoped cron session after delivery-none deleteAfterRun jobs", async () => {
    dispatchCronDeliveryMock.mockImplementationOnce(
      (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
        .dispatchCronDelivery,
    );
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "none" },
          payload: { kind: "agentTurn", message: "cleanup me", model: "openai/gpt-4" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: "agent:default:cron:test",
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "test-session-id",
        expectedLifecycleRevision: "test-lifecycle-revision",
        expectedSessionUpdatedAt: 0,
      },
      timeoutMs: 10_000,
    });
  });

  it("leaves transcript cleanup with dispatch when delivery rejects", async () => {
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "messagechat",
      to: "test-target",
    });
    dispatchCronDeliveryMock.mockRejectedValueOnce(new Error("delivery receipt store unavailable"));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "messagechat", to: "test-target" },
          payload: { kind: "agentTurn", message: "cleanup once", model: "openai/gpt-4" },
        }),
      }),
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe("delivery receipt store unavailable");
    expect(dispatchCronDeliveryMock).toHaveBeenCalledOnce();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledWith({
      sessionId: "test-session-id",
      reason: "isolated-cron-dispose",
      onError: expect.any(Function),
    });
  });

  it("retires the previous bundled MCP runtime when a persistent cron session rolls over", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        previousSessionId: "stale-session-id",
        sessionEntry: { ...makeCronSession().sessionEntry, sessionId: "rotated-session-id" },
      }),
    );
    mockRunCronFallbackPassthrough();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ sessionTarget: "session:agent:main:main:thread:9999" }),
      }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupBundleMcpOnRunEnd: false,
        allowGatewaySubagentBinding: true,
      }),
    );
    expect(retireSessionMcpRuntimeMock).toHaveBeenCalledExactlyOnceWith({
      sessionId: "stale-session-id",
      reason: "cron-session-rollover",
      onError: expect.any(Function),
    });
  });
});
