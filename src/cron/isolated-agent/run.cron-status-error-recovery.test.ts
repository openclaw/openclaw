import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import { loadRunCronIsolatedAgentTurn, runWithModelFallbackMock } from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — error payload recovery (#32244)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks run as ok when non-error payload with text follows an error payload", async () => {
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [
          { text: "Write: to ~/file.md failed", isError: true },
          { text: "File written successfully" },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("ok");
  });

  it("marks run as ok when non-error payload appears BEFORE the last error payload", async () => {
    // The model produces useful output first, then a tool error at the end.
    // The run should still be considered successful since it has deliverable content.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [
          { text: "Here is the report for today." },
          { text: "Write: to ~/file.md (6827 chars) failed", isError: true },
        ],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("ok");
  });

  it("marks run as error when only error payloads exist (no recovery)", async () => {
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "Connection refused", isError: true }],
        meta: { agentMeta: { usage: { input: 10, output: 20 } } },
      },
      provider: "openai",
      model: "gpt-4",
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("error");
  });

  it("marks run as error when run-level error exists even with non-error payloads", async () => {
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "partial output" }, { text: "context overflow", isError: true }],
        meta: {
          agentMeta: { usage: { input: 10, output: 20 } },
          error: "context length exceeded",
        },
      },
      provider: "openai",
      model: "gpt-4",
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());
    expect(result.status).toBe("error");
  });
});
