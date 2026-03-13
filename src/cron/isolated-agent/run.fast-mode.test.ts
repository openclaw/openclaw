import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fast mode", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes config-driven fast mode into embedded cron runs", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      return {
        result: {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        },
        provider,
        model,
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-4": {
                  params: {
                    fastMode: true,
                  },
                },
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test fast mode",
            model: "openai/gpt-4",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-4",
      fastMode: true,
    });
  });

  it("honors session fastMode=false over config fastMode=true", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        ...makeCronSession().sessionEntry,
        fastMode: false,
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      return {
        result: {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        },
        provider,
        model,
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-4": {
                  params: {
                    fastMode: true,
                  },
                },
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test fast mode override",
            model: "openai/gpt-4",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-4",
      fastMode: false,
    });
  });

  it("honors session fastMode=true over config fastMode=false", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        ...makeCronSession().sessionEntry,
        fastMode: true,
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      await run(provider, model);
      return {
        result: {
          payloads: [{ text: "ok" }],
          meta: { agentMeta: { usage: { input: 10, output: 20 } } },
        },
        provider,
        model,
        attempts: [],
      };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-4": {
                  params: {
                    fastMode: false,
                  },
                },
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test fast mode session override",
            model: "openai/gpt-4",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "gpt-4",
      fastMode: true,
    });
  });
});
