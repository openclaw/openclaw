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

describe("runCronIsolatedAgentTurn - payload.paths policy", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes normalized payload.paths policy to embedded runs", async () => {
    runWithModelFallbackMock.mockImplementationOnce(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("openai", "gpt-4");
        return { result, provider: "openai", model: "gpt-4", attempts: [] };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            paths: {
              allow: [" reports/** ", "reports/**"],
              deny: ["notes/conversations/**", " "],
            },
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      writePathPolicy: {
        allow: ["reports/**"],
        deny: ["notes/conversations/**"],
      },
    });
  });
});
