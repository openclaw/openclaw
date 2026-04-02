import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function mockSuccessfulModelFallback() {
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
}

describe("runCronIsolatedAgentTurn — working memory", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("does not implicitly enable scoped working memory for light-context cron jobs", async () => {
    mockSuccessfulModelFallback();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            lightContext: true,
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.bootstrapContextMode).toBe("lightweight");
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.workingMemoryPath).toBeUndefined();
  });

  it("passes explicit scoped working memory through to the isolated runner", async () => {
    mockSuccessfulModelFallback();
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            lightContext: true,
            workingMemoryPath: ".openclaw/working-memory/cron/nightly.md",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.workingMemoryPath).toBe(
      ".openclaw/working-memory/cron/nightly.md",
    );
  });
});
