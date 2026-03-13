import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  restoreFastTestEnv,
  runCliAgentMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "execution-session-key",
      name: "Execution Session Key",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "summarize latest items" },
      delivery: { mode: "none" },
    } as never,
    message: "summarize latest items",
    sessionKey: "cron:execution-session-key",
  };
}

describe("runCronIsolatedAgentTurn execution session key", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "run-123",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("uses the per-run session key when executing the isolated agent", async () => {
    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:cron:execution-session-key:run:run-123",
    );
  });

  it("uses the per-run session key when executing the CLI agent", async () => {
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "cli result" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    });

    await runCronIsolatedAgentTurn(makeParams());

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock.mock.calls[0]?.[0]?.sessionKey).toBe(
      "agent:default:cron:execution-session-key:run:run-123",
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
