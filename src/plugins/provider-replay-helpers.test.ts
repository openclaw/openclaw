import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectObjectFields as expectFields } from "../test-utils/mock-call-assertions.js";
import {
  buildAnthropicReplayPolicyForModel as anthropic,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy as hybrid,
  buildNativeAnthropicReplayPolicyForModel as nativeAnthropic,
  buildOpenAICompatibleReplayPolicy as openAI,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
  sanitizeGoogleGeminiReplayHistoryAsync,
  buildStrictAnthropicReplayPolicy,
} from "./provider-replay-helpers.js";

const sonnet = "claude-sonnet-4-6";
const legacySonnet = "claude-3-7-sonnet-20250219";
const strictAnthropicPolicy = {
  appendOnlyRuntimeContext: false,
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  preserveSignatures: true,
  repairToolUseResultPairing: true,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: true,
};
const hybridPolicy = (modelId: string, modelApi = "anthropic-messages") =>
  hybrid({ provider: "minimax", modelApi, modelId }, { anthropicModelDropThinkingBlocks: true });

describe("provider replay helpers", () => {
  it("builds strict openai-completions replay policy", () => {
    expectFields(openAI("openai-completions"), {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("omits tool-call id sanitization when opted out for openai-completions", () => {
    const policy = openAI("openai-completions", {
      sanitizeToolCallIds: false,
    });
    expectFields(policy, {
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("selects OpenAI-style ids for duplicate replay tool calls", () => {
    expect(openAI("openai-completions", { duplicateToolCallIdStyle: "openai" })).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      duplicateToolCallIdStyle: "openai",
    });
  });

  it("drops historical reasoning for OpenAI-compatible chat completions replay", () => {
    expect(openAI("openai-completions", { modelId: "qwen3.6-27b" })).toHaveProperty(
      "dropReasoningFromHistory",
      true,
    );
    expect(
      openAI("openai-completions", {
        modelId: "google/gemma-3-27b-it",
        dropReasoningFromHistory: false,
      }),
    ).not.toHaveProperty("dropReasoningFromHistory");
    expect(openAI("openai-responses", { modelId: "google/gemma-4-26b-a4b-it" })).not.toHaveProperty(
      "dropReasoningFromHistory",
    );
  });

  it("omits tool-call id sanitization when opted out for openai-responses", () => {
    const policy = openAI("openai-responses", { sanitizeToolCallIds: false });
    expectFields(policy, {
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("builds strict anthropic replay policy", () => {
    expectFields(buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: true }), {
      appendOnlyRuntimeContext: false,
      sanitizeMode: "full",
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });

  it("retains operator context for an admitted in-history system route", () => {
    expect(nativeAnthropic("claude-opus-5", undefined, true)).toMatchObject({
      inHistorySystemUpdates: true,
      appendOnlyRuntimeContext: true,
      preserveNativeAnthropicToolUseIds: true,
    });
  });

  it.each([
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", false],
  ])("scopes append-only replay to prefix-binding %s", (modelId, expected) => {
    for (const buildPolicy of [anthropic, nativeAnthropic]) {
      expect(buildPolicy(modelId).appendOnlyRuntimeContext).toBe(expected);
      expect(
        buildPolicy("deployment", { params: { canonicalModelId: modelId } })
          .appendOnlyRuntimeContext,
      ).toBe(expected);
    }
    for (const modelApi of ["anthropic-messages", "bedrock-converse-stream"]) {
      expect(
        hybrid({
          provider: "custom-proxy",
          modelApi,
          modelId: "deployment",
          model: {
            ...makeProviderModelFixture({
              id: "deployment",
              api: modelApi,
              provider: "custom-proxy",
              baseUrl: "https://example.invalid",
            }),
            params: { canonicalModelId: modelId },
          },
        })?.appendOnlyRuntimeContext,
      ).toBe(expected);
    }
  });

  it("preserves thinking blocks only for Claude models with native history support", () => {
    for (const modelId of [
      "claude-fable-5",
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-mythos-5",
      "us.anthropic.claude-opus-5-20260101-v1:0",
    ]) {
      const policy = anthropic(modelId);
      expect(policy).not.toHaveProperty("dropThinkingBlocks");
    }

    for (const modelId of [
      "claude-opus-4-1",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20240620",
      "claude-3-opus-20240229",
      "claude-opus-50",
      "claude-sonnet-50",
      "claude-sonnet-4-60",
    ]) {
      const policy = anthropic(modelId);
      expect(policy.dropThinkingBlocks).toBe(true);
    }
  });

  it("uses canonical deployment metadata for Claude replay policy", () => {
    expect(
      anthropic("prod-opus", {
        params: { canonicalModelId: "claude-opus-5" },
      }),
    ).not.toHaveProperty("dropThinkingBlocks");
    expect(
      anthropic("prod-sonnet", {
        params: { canonicalModelId: "claude-sonnet-4-5-20250929" },
      }),
    ).toHaveProperty("dropThinkingBlocks", true);
  });

  it.each([anthropic, nativeAnthropic])("derives strict Claude replay through %s", (build) => {
    const policy = build(sonnet);
    expect(policy).toMatchObject(strictAnthropicPolicy);
    if (build === nativeAnthropic) {
      expect(policy).toHaveProperty("preserveNativeAnthropicToolUseIds", true);
    }
    expect(policy).not.toHaveProperty("dropThinkingBlocks");
    expect(build(legacySonnet)).toHaveProperty("dropThinkingBlocks", true);
    expect(build("amazon.nova-pro-v1")).not.toHaveProperty("dropThinkingBlocks");
  });

  it("builds hybrid anthropic or openai replay policy", () => {
    const sonnet46Policy = hybridPolicy(sonnet);
    expectFields(sonnet46Policy, {
      appendOnlyRuntimeContext: false,
      validateAnthropicTurns: true,
    });
    expect(sonnet46Policy).not.toHaveProperty("dropThinkingBlocks");

    expectFields(hybridPolicy(legacySonnet), {
      validateAnthropicTurns: true,
      dropThinkingBlocks: true,
    });
    expect(hybridPolicy("MiniMax-M2.7", "openai-completions")).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
    });
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
      sessionId: "session-1",
      messages: [makeAgentAssistantMessage({ content: [{ type: "text", text: "hello" }] })],
      sessionState: {
        getCustomEntries: () => customEntries,
        appendCustomEntry: (customType: string, data: unknown) => {
          customEntries.push({ customType, data });
        },
      },
    } as never);

    expect(result[0]).toMatchObject({ role: "user", content: "(session bootstrap)" });
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
