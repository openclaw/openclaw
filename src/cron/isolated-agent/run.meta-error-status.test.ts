import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  pickLastNonEmptyTextFromPayloadsMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — meta.error status propagation (#43604)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("marks run as error when meta.error is set with no error payloads", async () => {
    // Simulate: model returns successfully but with a run-level error and
    // no isError payloads (e.g. provider outage that surfaces as meta.error
    // without producing an explicit error payload).
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "" }],
        meta: {
          error: { kind: "provider_error", message: "model provider unreachable" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("");

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("model provider unreachable");
  });

  it("marks run as error when meta.error is set with empty payloads", async () => {
    // Simulate: model completely fails, no payloads at all.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [],
        meta: {
          error: { kind: "connection_refused", message: "ECONNREFUSED" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      attempts: [],
    });
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("");

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("marks run as error when meta.error is a string", async () => {
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [],
        meta: {
          error: "rate limit exceeded",
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("");

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("rate limit exceeded");
  });

  it("still reports ok when meta.error is absent and no error payloads", async () => {
    // Normal success path — no regression.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "backup completed successfully" }],
        meta: {
          agentMeta: { usage: { input: 100, output: 50 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("backup completed successfully");

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("prefers error payload text over meta.error message when both present", async () => {
    // Both channels report an error — payload text should win since it's
    // more specific / user-facing.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "Request failed after repeated internal retries.", isError: true }],
        meta: {
          error: { kind: "retry_limit", message: "generic retry limit" },
          agentMeta: { usage: { input: 0, output: 0 } },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });
    pickLastNonEmptyTextFromPayloadsMock.mockReturnValue(
      "Request failed after repeated internal retries.",
    );

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("error");
    expect(result.error).toBe("Request failed after repeated internal retries.");
  });
});
