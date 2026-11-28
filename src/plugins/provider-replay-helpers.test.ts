import { describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
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
const strictAnthropicPolicy = {
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  preserveSignatures: true,
  repairToolUseResultPairing: true,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: true,
};
const hybridPolicy = (modelId: string, modelApi = "anthropic-messages") =>
  hybrid({ provider: "minimax", modelApi, modelId });

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

  it.each(["openai-completions", "openai-responses"])("omits opted-out tool ids for %s", (api) => {
    const policy = openAI(api, { sanitizeToolCallIds: false });
    const completion = api === "openai-completions";
    expectFields(policy, {
      applyAssistantFirstOrderingFix: completion,
      validateGeminiTurns: completion,
      validateAnthropicTurns: completion,
      ...(!completion ? { allowSyntheticToolResults: true } : {}),
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

  it("builds strict anthropic replay policy", () => {
    expectFields(buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: true }), {
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

  // Every Claude model keeps the host default (retained carriers); only an explicit opt-out
  // or an in-history route sets the field.
  it.each(["claude-fable-5-1", "claude-mythos-5-1", "claude-zzz-9-9", "claude-opus-5"])(
    "leaves runtime-context retention to the host default for %s",
    (modelId) => {
      for (const buildPolicy of [anthropic, nativeAnthropic]) {
        expect(buildPolicy(modelId)).not.toHaveProperty("appendOnlyRuntimeContext");
      }
      expect(buildStrictAnthropicReplayPolicy({ appendOnlyRuntimeContext: false })).toMatchObject({
        appendOnlyRuntimeContext: false,
      });
    },
  );

  it.each([anthropic, nativeAnthropic])(
    "replays stored thinking on every Claude model through %s",
    (build) => {
      for (const modelId of [
        "claude-haiku-4-5-20251001",
        "claude-sonnet-4-5-20250929",
        "claude-3-7-sonnet-20250219",
        sonnet,
        "claude-opus-5",
      ]) {
        const policy = build(modelId);
        expect(policy).toMatchObject(strictAnthropicPolicy);
        expect(policy).not.toHaveProperty("dropThinkingBlocks");
      }
      if (build === nativeAnthropic) {
        expect(build(sonnet)).toHaveProperty("preserveNativeAnthropicToolUseIds", true);
      }
    },
  );

  it("builds hybrid anthropic or openai replay policy", () => {
    const anthropicPolicy = hybridPolicy(sonnet);
    expectFields(anthropicPolicy, { validateAnthropicTurns: true });
    expect(anthropicPolicy).not.toHaveProperty("appendOnlyRuntimeContext");
    expect(anthropicPolicy).not.toHaveProperty("dropThinkingBlocks");
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
