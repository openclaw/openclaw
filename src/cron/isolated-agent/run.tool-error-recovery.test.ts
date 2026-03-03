import { describe, expect, it, type Mock } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const helpers = await import("./helpers.js");
const pickLastDeliverablePayloadMock = helpers.pickLastDeliverablePayload as unknown as Mock;

describe("runCronIsolatedAgentTurn — tool error recovery (#32244)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("reports ok when a non-error deliverable payload exists alongside a tool error", async () => {
    const nonErrorPayload = { text: "Report written to ~/docs/report.md" };
    const errorPayload = { text: "⚠️ Write failed", isError: true as const };

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [nonErrorPayload, errorPayload],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });
    pickLastDeliverablePayloadMock.mockReturnValue(nonErrorPayload);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");
  });

  it("still reports error when only error payloads exist (no non-error deliverable)", async () => {
    const errorPayload = { text: "⚠️ Write failed", isError: true as const };

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [errorPayload],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });
    pickLastDeliverablePayloadMock.mockReturnValue(errorPayload);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("error");
  });

  it("still reports error when there is a run-level error despite non-error deliverable", async () => {
    const nonErrorPayload = { text: "Report written" };
    const errorPayload = { text: "Context overflow", isError: true as const };

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [nonErrorPayload, errorPayload],
        meta: {
          error: "context window exceeded",
          agentMeta: { usage: { input: 10, output: 20 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
    });
    pickLastDeliverablePayloadMock.mockReturnValue(nonErrorPayload);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("error");
  });
});
