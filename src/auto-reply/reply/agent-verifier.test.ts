import { completeSimple, type AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseVerificationResponse, verifyAgentResponse } from "./agent-verifier.js";

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

  it("returns failed with feedback for FAIL: prefix", () => {
    expect(parseVerificationResponse("FAIL: some reason")).toEqual({
      passed: false,
      feedback: "some reason",
    });
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
