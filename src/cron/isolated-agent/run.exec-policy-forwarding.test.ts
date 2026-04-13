import { describe, expect, it } from "vitest";
import "../isolated-agent.mocks.js";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "../isolated-agent/run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedPiAgentMock,
} from "../isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn exec policy forwarding", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("forwards payload.execPolicy into embedded agent execOverrides", async () => {
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: {
          payload: {
            kind: "agentTurn",
            message: "test",
            execPolicy: {
              security: "full",
              ask: "off",
            },
          },
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toMatchObject({
      execOverrides: {
        security: "full",
        ask: "off",
      },
    });
  });
});
