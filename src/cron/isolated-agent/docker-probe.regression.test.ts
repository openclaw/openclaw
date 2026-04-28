import { describe, expect, it, vi } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

vi.mock("../../agents/sandbox/backend.js", () => ({
  requireSandboxBackendFactory: vi.fn(() => {
    throw new Error("failed to connect to the docker API");
  }),
}));

describe("isolated session docker probe regression (#73586)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("passes sandboxSessionKey so sandbox mode=off is respected", async () => {
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "test",
            model: "openai/gpt-4",
          },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0][0];
    // The agent session key must be passed as sandboxSessionKey so the
    // sandbox resolver evaluates the canonical agent key instead of the
    // run-scoped UUID fallback.
    expect(callArgs.sandboxSessionKey).toBe("agent:default:cron:test");
  });
});
