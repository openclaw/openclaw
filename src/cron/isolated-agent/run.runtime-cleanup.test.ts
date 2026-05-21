import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAgentRunContextMock,
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "cron-runtime-cleanup",
      name: "Runtime Cleanup",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run task" },
    },
    message: "run task",
    sessionKey: "cron:runtime-cleanup",
  } as never;
}

describe("runCronIsolatedAgentTurn runtime cleanup", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
  });

  afterEach(() => {
    if (previousFastTestEnv !== undefined) {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    } else {
      delete process.env.OPENCLAW_TEST_FAST;
    }
  });

  it("releases the cron session store after a successful run", async () => {
    const cronSession = makeCronSession({
      store: {
        "agent:main:cron:runtime-cleanup": {
          sessionId: "session-1",
          skillsSnapshot: { prompt: "very large prompt", skills: [] },
        },
      },
      sessionEntry: makeCronSessionEntry({
        sessionId: "session-1",
        skillsSnapshot: { prompt: "very large prompt", skills: [] },
      }),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          provider: "openai",
          model: "gpt-4",
          usage: { input: 1, output: 2 },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("ok");
    expect(cronSession.store).toBeUndefined();
    expect(clearAgentRunContextMock).toHaveBeenCalledWith("session-1");
  });

  it("releases the cron session store after a failed run", async () => {
    const cronSession = makeCronSession({
      store: {
        "agent:main:cron:runtime-cleanup": {
          sessionId: "session-2",
          skillsSnapshot: { prompt: "very large prompt", skills: [] },
        },
      },
      sessionEntry: makeCronSessionEntry({
        sessionId: "session-2",
        skillsSnapshot: { prompt: "very large prompt", skills: [] },
      }),
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("boom"));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(cronSession.store).toBeUndefined();
    expect(clearAgentRunContextMock).toHaveBeenCalledWith("session-2");
  });
});
