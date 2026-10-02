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
  runCliAgentMock,
  isCliProviderMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fast mode and session cleanup", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it.each([
    { runner: "embedded", configMode: "auto", sessionMode: undefined, mode: "auto", cutoff: 30 },
    { runner: "embedded", configMode: true, sessionMode: false, mode: false, cutoff: 60 },
    { runner: "CLI", configMode: "auto", sessionMode: undefined, mode: "auto", cutoff: 15 },
    { runner: "CLI", configMode: false, sessionMode: undefined, mode: false, cutoff: 15 },
  ] as const)(
    "forwards $mode fast mode and its cutoff to the $runner runner",
    async ({ runner, configMode, sessionMode, mode, cutoff }) => {
      const session = makeCronSession();
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({ sessionEntry: { ...session.sessionEntry, fastMode: sessionMode } }),
      );
      mockRunCronFallbackPassthrough();
      if (runner === "CLI") {
        isCliProviderMock.mockReturnValue(true);
        runCliAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: { agentMeta: {} } });
      }
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          cfg: {
            agents: {
              defaults: {
                models: {
                  "openai/gpt-5.4": { params: { fastMode: configMode, fastAutoOnSeconds: cutoff } },
                },
              },
            },
          },
          job: makeIsolatedAgentJobFixture({
            payload: { kind: "agentTurn", message: "test fast mode", model: "openai/gpt-5.4" },
          }),
        }),
      );
      expect(result.status).toBe("ok");
      expect(
        runner === "CLI" ? runCliAgentMock : runEmbeddedAgentMock,
      ).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ fastMode: mode, fastModeAutoOnSeconds: cutoff }),
      );
    },
  );

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
        sessionKey: "agent:main:main:thread:9999",
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
