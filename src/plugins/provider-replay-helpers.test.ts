/** Tests provider replay helper normalization and deterministic ordering. */
import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
  sanitizeGoogleGeminiReplayHistoryAsync,
} from "./provider-replay-helpers.js";

function expectFields(actual: unknown, expected: Record<string, unknown>): void {
  if (!actual || typeof actual !== "object") {
    throw new Error("Expected record");
  }
  const record = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key]).toEqual(value);
  }
}

describe("provider replay helpers", () => {
  it("selects OpenAI-style ids for duplicate replay tool calls", () => {
    expectFields(
      buildOpenAICompatibleReplayPolicy("openai-completions", {
        duplicateToolCallIdStyle: "openai",
      }),
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        duplicateToolCallIdStyle: "openai",
      },
    );
  });

  it("drops historical reasoning for OpenAI-compatible chat completions replay", () => {
    expect(
      buildOpenAICompatibleReplayPolicy("openai-completions", {
        modelId: "qwen3.6-27b",
      }),
    ).toHaveProperty("dropReasoningFromHistory", true);
    expect(
      buildOpenAICompatibleReplayPolicy("openai-completions", {
        modelId: "google/gemma-3-27b-it",
        dropReasoningFromHistory: false,
      }),
    ).not.toHaveProperty("dropReasoningFromHistory");
    expect(
      buildOpenAICompatibleReplayPolicy("openai-completions", {
        modelId: "google/gemma-4-26b-a4b-it",
        dropReasoningFromHistory: false,
      }),
    ).not.toHaveProperty("dropReasoningFromHistory");
    expect(
      buildOpenAICompatibleReplayPolicy("openai-responses", {
        modelId: "google/gemma-4-26b-a4b-it",
      }),
    ).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("omits tool-call id sanitization when opted out for openai-responses", () => {
    const policy = buildOpenAICompatibleReplayPolicy("openai-responses", {
      sanitizeToolCallIds: false,
    });
    expectFields(policy, {
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("retains operator context for an admitted in-history system route", () => {
    expect(
      buildNativeAnthropicReplayPolicyForModel("claude-opus-5", undefined, true),
    ).toMatchObject({
      inHistorySystemUpdates: true,
      appendOnlyRuntimeContext: true,
      preserveNativeAnthropicToolUseIds: true,
    });
  });

  it.each([
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", false],
  ])("scopes append-only replay to prefix-binding %s", (modelId, expected) => {
    for (const buildPolicy of [
      buildAnthropicReplayPolicyForModel,
      buildNativeAnthropicReplayPolicyForModel,
    ]) {
      expect(buildPolicy(modelId).appendOnlyRuntimeContext).toBe(expected);
      expect(
        buildPolicy("deployment", { params: { canonicalModelId: modelId } })
          .appendOnlyRuntimeContext,
      ).toBe(expected);
    }
    for (const modelApi of ["anthropic-messages", "bedrock-converse-stream"]) {
      expect(
        buildHybridAnthropicOrOpenAIReplayPolicy({
          provider: "custom-proxy",
          modelApi,
          modelId: "deployment",
          model: {
            id: "deployment",
            name: "Deployment",
            api: modelApi,
            provider: "custom-proxy",
            baseUrl: "https://example.invalid",
            input: ["text"],
            reasoning: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
            params: { canonicalModelId: modelId },
          },
        })?.appendOnlyRuntimeContext,
      ).toBe(expected);
    }
  });

  it("derives claude-only anthropic replay policy from the model id", () => {
    // Sonnet 4.6 preserves thinking blocks (no drop)
    expectFields(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6"), {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
    // Legacy models still drop thinking blocks
    expect(buildAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219")).toHaveProperty(
      "dropThinkingBlocks",
      true,
    );
    expect(buildAnthropicReplayPolicyForModel("amazon.nova-pro-v1")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
  });

  it("builds native Anthropic replay policy with selective tool-call id preservation", () => {
    // Sonnet 4.6 preserves thinking blocks
    const policy46 = buildNativeAnthropicReplayPolicyForModel("claude-sonnet-4-6");
    expectFields(policy46, {
      appendOnlyRuntimeContext: false,
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(policy46).not.toHaveProperty("dropThinkingBlocks");

    // Legacy model drops thinking blocks
    expect(
      buildNativeAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219").dropThinkingBlocks,
    ).toBe(true);
  });

  it("builds hybrid anthropic or openai replay policy", () => {
    const sonnet46Policy = buildHybridAnthropicOrOpenAIReplayPolicy(
      {
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never,
      { anthropicModelDropThinkingBlocks: true },
    );
    expectFields(sonnet46Policy, {
      appendOnlyRuntimeContext: false,
      validateAnthropicTurns: true,
    });
    expect(sonnet46Policy).not.toHaveProperty("dropThinkingBlocks");

    expectFields(
      buildHybridAnthropicOrOpenAIReplayPolicy(
        {
          provider: "minimax",
          modelApi: "anthropic-messages",
          modelId: "claude-3-7-sonnet-20250219",
        } as never,
        { anthropicModelDropThinkingBlocks: true },
      ),
      {
        validateAnthropicTurns: true,
        dropThinkingBlocks: true,
      },
    );

    expectFields(
      buildHybridAnthropicOrOpenAIReplayPolicy({
        provider: "minimax",
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
      } as never),
      {
        sanitizeToolCallIds: true,
        applyAssistantFirstOrderingFix: true,
      },
    );
  });

  it("builds Gemini replay helpers and tagged reasoning mode", () => {
    expectFields(buildGoogleGeminiReplayPolicy(), {
      appendOnlyRuntimeContext: false,
      validateGeminiTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(resolveTaggedReasoningOutputMode()).toBe("tagged");
  });

  it("builds passthrough Gemini signature sanitization only when needed", () => {
    expectFields(buildPassthroughGeminiSanitizingReplayPolicy("gemini-2.5-pro"), {
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
    expect(
      buildPassthroughGeminiSanitizingReplayPolicy("anthropic/claude-sonnet-4-6"),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("retains the deprecated synchronous Gemini replay adapter", () => {
    const customEntries: Array<{ customType: string; data: unknown }> = [];

    const result = sanitizeGoogleGeminiReplayHistory({
      provider: "google",
      modelApi: "google-generative-ai",
      modelId: "gemini-3.1-pro-preview",
      sessionId: "session-1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      sessionState: {
        getCustomEntries: () => customEntries,
        appendCustomEntry: (customType: string, data: unknown) => {
          customEntries.push({ customType, data });
        },
      },
    } as never);

    const bootstrapMessage = result[0] as { role?: string; content?: unknown } | undefined;
    expect(bootstrapMessage?.role).toBe("user");
    expect(bootstrapMessage?.content).toBe("(session bootstrap)");
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });
});

it("awaits the Gemini bootstrap marker and propagates write failure without sync fallback", async () => {
  const committed = createDeferredCore<string>();
  const legacy = vi.fn(() => {
    throw new Error("synchronous persistence called");
  });
  const sessionState = {
    getCustomEntries: () => [],
    appendCustomEntry: legacy,
    appendCustomEntryAsync: vi.fn(() => committed.promise),
  };
  const context = {
    provider: "google",
    sessionId: "awaited-replay",
    messages: [makeAgentAssistantMessage({ content: [{ type: "text", text: "hello" }] })],
    sessionState,
  };
  let completed = false;
  const replay = sanitizeGoogleGeminiReplayHistoryAsync(context).then((messages) => {
    completed = true;
    return messages;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  committed.resolve("bootstrap-marker");
  const messages = await replay;
  expect(messages[0]).toMatchObject({ role: "user", content: "(session bootstrap)" });
  expect(legacy).not.toHaveBeenCalled();

  sessionState.appendCustomEntryAsync.mockRejectedValueOnce(new Error("worker commit rejected"));
  await expect(sanitizeGoogleGeminiReplayHistoryAsync(context)).rejects.toThrow(
    "worker commit rejected",
  );
  expect(legacy).not.toHaveBeenCalled();
});
