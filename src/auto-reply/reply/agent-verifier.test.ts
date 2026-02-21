import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  assembleVerifierContext,
  parseVerificationResponse,
  shouldSkipVerification,
  verifyAgentResponse,
} from "./agent-verifier.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(async () => null),
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((_provider: string, modelId: string) => ({
    model: {
      provider: "anthropic",
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  })),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key" as const,
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

const mockedCompleteSimple = vi.mocked(completeSimple);

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const baseCfg = {} as OpenClawConfig;
const baseParams = {
  userMessage: "What is 2+2?",
  agentResponse: "4",
  model: "anthropic/claude-sonnet-4-5",
  cfg: baseCfg,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseVerificationResponse", () => {
  it("returns passed for PASS", () => {
    expect(parseVerificationResponse("PASS")).toEqual({ passed: true });
  });

  it("returns passed for PASS with surrounding whitespace", () => {
    expect(parseVerificationResponse("  PASS  ")).toEqual({ passed: true });
  });

  it("returns passed for **PASS** (markdown bold)", () => {
    expect(parseVerificationResponse("The response looks good.\n**PASS**")).toEqual({
      passed: true,
    });
  });

  it("returns failed with feedback for FAIL: prefix (legacy)", () => {
    expect(parseVerificationResponse("FAIL: some reason")).toEqual({
      passed: false,
      feedback: "some reason",
    });
  });

  it("returns failed with category for FAIL [category]: prefix", () => {
    const result = parseVerificationResponse(
      "FAIL [incomplete]: Missing error handling for the endpoints.",
    );
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Missing error handling for the endpoints.");
    expect(result.failCategory).toBe("incomplete");
  });

  it("returns failed with category for **FAIL [category]**: (markdown bold)", () => {
    const result = parseVerificationResponse(
      "The response misses the point.\n**FAIL [goal_missed]**: Did not answer the actual question.",
    );
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("Did not answer the actual question.");
    expect(result.failCategory).toBe("goal_missed");
  });

  it("returns undefined failCategory for unknown category", () => {
    const result = parseVerificationResponse("FAIL [unknown_cat]: some reason");
    expect(result.passed).toBe(false);
    expect(result.feedback).toBe("some reason");
    expect(result.failCategory).toBeUndefined();
  });

  it("returns failed with multi-line feedback", () => {
    const result = parseVerificationResponse("FAIL: line one\nline two");
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("line one");
    expect(result.feedback).toContain("line two");
  });

  it("returns passed for empty string (fail-open)", () => {
    expect(parseVerificationResponse("")).toEqual({ passed: true });
  });

  it("returns passed for malformed response (fail-open)", () => {
    expect(parseVerificationResponse("I'm not sure what you mean")).toEqual({
      passed: true,
    });
  });
});

describe("shouldSkipVerification", () => {
  it("returns 'tool_calls' when stopReason is tool_calls", () => {
    expect(
      shouldSkipVerification({
        responseText: "some text",
        runMeta: { stopReason: "tool_calls" },
      }),
    ).toBe("tool_calls");
  });

  it("returns 'tool_calls' when pendingToolCalls is true", () => {
    expect(
      shouldSkipVerification({
        responseText: "some text",
        runMeta: { pendingToolCalls: true },
      }),
    ).toBe("tool_calls");
  });

  it("returns 'messaging_tool_sent' when didSendViaMessagingTool", () => {
    expect(
      shouldSkipVerification({
        responseText: "some text",
        runMeta: { didSendViaMessagingTool: true },
      }),
    ).toBe("messaging_tool_sent");
  });

  it("returns 'block_streaming_sent' when directlySentBlockKeys has entries", () => {
    expect(
      shouldSkipVerification({
        responseText: "some text",
        directlySentBlockKeys: new Set(["block-0"]),
      }),
    ).toBe("block_streaming_sent");
  });

  it("returns 'empty_response' for whitespace-only text", () => {
    expect(shouldSkipVerification({ responseText: "   " })).toBe("empty_response");
  });

  it("returns undefined when no skip conditions are met", () => {
    expect(
      shouldSkipVerification({
        responseText: "Hello, I completed the task.",
        runMeta: { stopReason: "stop" },
      }),
    ).toBeUndefined();
  });
});

describe("assembleVerifierContext", () => {
  it("includes user message and agent response", async () => {
    const ctx = await assembleVerifierContext({
      userMessage: "Build an API",
      agentResponse: "Here is the API code.",
      model: "test",
      cfg: baseCfg,
    });
    expect(ctx).toContain("<user_message>");
    expect(ctx).toContain("Build an API");
    expect(ctx).toContain("<agent_response>");
    expect(ctx).toContain("Here is the API code.");
  });

  it("includes conversation history when provided", async () => {
    const ctx = await assembleVerifierContext({
      userMessage: "Continue",
      agentResponse: "Done.",
      model: "test",
      cfg: baseCfg,
      conversationHistory: [
        { sender: "user", body: "Hello" },
        { sender: "assistant", body: "Hi there" },
      ],
    });
    expect(ctx).toContain("<conversation_history>");
    expect(ctx).toContain("[user]: Hello");
    expect(ctx).toContain("[assistant]: Hi there");
  });

  it("limits conversation history to MAX_HISTORY_ENTRIES (5)", async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      sender: "user",
      body: `Message ${i}`,
    }));
    const ctx = await assembleVerifierContext({
      userMessage: "test",
      agentResponse: "done",
      model: "test",
      cfg: baseCfg,
      conversationHistory: history,
    });
    expect(ctx).not.toContain("Message 0");
    expect(ctx).not.toContain("Message 4");
    expect(ctx).toContain("Message 5");
    expect(ctx).toContain("Message 9");
  });

  it("includes execution metadata when provided", async () => {
    const ctx = await assembleVerifierContext({
      userMessage: "test",
      agentResponse: "done",
      model: "test",
      cfg: baseCfg,
      runMeta: { stopReason: "stop", durationMs: 1234 },
    });
    expect(ctx).toContain("<execution_context>");
    expect(ctx).toContain("stop_reason: stop");
    expect(ctx).toContain("duration: 1234ms");
  });

  it("includes previous feedback for retries", async () => {
    const ctx = await assembleVerifierContext({
      userMessage: "test",
      agentResponse: "improved response",
      model: "test",
      cfg: baseCfg,
      previousFeedback: "Missing error handling",
    });
    expect(ctx).toContain("<previous_verification_feedback>");
    expect(ctx).toContain("Missing error handling");
  });

  it("truncates agent response that exceeds cap", async () => {
    const longResponse = "x".repeat(15_000);
    const ctx = await assembleVerifierContext({
      userMessage: "test",
      agentResponse: longResponse,
      model: "test",
      cfg: baseCfg,
    });
    expect(ctx).toContain("[... response truncated]");
    expect(ctx.length).toBeLessThan(longResponse.length);
  });

  it("skips workspace sections when workspaceDir is not provided", async () => {
    const ctx = await assembleVerifierContext({
      userMessage: "test",
      agentResponse: "done",
      model: "test",
      cfg: baseCfg,
    });
    expect(ctx).not.toContain("<user_rules>");
  });
});

describe("verifyAgentResponse", () => {
  it("returns passed when LLM responds with PASS", async () => {
    mockedCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("PASS"));
    const result = await verifyAgentResponse(baseParams);
    expect(result).toEqual({ passed: true });
    expect(mockedCompleteSimple).toHaveBeenCalledOnce();
  });

  it("returns failed with feedback when LLM responds with FAIL:", async () => {
    mockedCompleteSimple.mockResolvedValueOnce(
      makeAssistantMessage("FAIL: The response does not address the question"),
    );
    const result = await verifyAgentResponse(baseParams);
    expect(result).toEqual({
      passed: false,
      feedback: "The response does not address the question",
    });
  });

  it("returns failed with category from structured FAIL response", async () => {
    mockedCompleteSimple.mockResolvedValueOnce(
      makeAssistantMessage(
        "The response omits validation.\n**FAIL [incomplete]**: Missing input validation for the API.",
      ),
    );
    const result = await verifyAgentResponse(baseParams);
    expect(result.passed).toBe(false);
    expect(result.failCategory).toBe("incomplete");
    expect(result.feedback).toContain("Missing input validation");
  });

  it("passes enriched context to the LLM call", async () => {
    mockedCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("PASS"));
    await verifyAgentResponse({
      ...baseParams,
      conversationHistory: [{ sender: "user", body: "Earlier message" }],
      runMeta: { stopReason: "stop", durationMs: 500 },
    });

    const callArgs = mockedCompleteSimple.mock.calls[0];
    const messageContent = (callArgs[1] as { messages: Array<{ content: string }> }).messages[0]
      .content;
    expect(messageContent).toContain("<conversation_history>");
    expect(messageContent).toContain("Earlier message");
    expect(messageContent).toContain("<execution_context>");
    expect(messageContent).toContain("stop_reason: stop");
  });

  it("returns passed on timeout (fail-open)", async () => {
    mockedCompleteSimple.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new DOMException("The operation was aborted", "AbortError")), 5),
        ),
    );
    const result = await verifyAgentResponse({ ...baseParams, timeoutMs: 1 });
    expect(result).toEqual({ passed: true });
  });

  it("returns passed on LLM error/exception (fail-open)", async () => {
    mockedCompleteSimple.mockRejectedValueOnce(new Error("API rate limited"));
    const result = await verifyAgentResponse(baseParams);
    expect(result).toEqual({ passed: true });
  });

  it("returns passed on malformed LLM response (fail-open)", async () => {
    mockedCompleteSimple.mockResolvedValueOnce(
      makeAssistantMessage("The response seems okay but I cannot determine definitively."),
    );
    const result = await verifyAgentResponse(baseParams);
    expect(result).toEqual({ passed: true });
  });
});
