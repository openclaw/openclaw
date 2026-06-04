// TTS core tests cover provider selection, synthesis, and error handling.
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Usage } from "../llm/types.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

const modelOverridePolicy: SpeechModelOverridePolicy = {
  enabled: false,
  allowText: false,
  allowProvider: false,
  allowVoice: false,
  allowModelId: false,
  allowVoiceSettings: false,
  allowNormalization: false,
  allowSeed: false,
};

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function createSummarizeTextFixture(content: AssistantMessage["content"]) {
  const model = {
    id: "test-model",
    name: "Test Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  } satisfies Model;
  const config = {
    auto: "off",
    mode: "final",
    provider: "test-provider",
    providerSource: "config",
    personas: {},
    summaryModel: "test-provider/test-model",
    modelOverrides: modelOverridePolicy,
    providerConfigs: {},
    maxTextLength: 10_000,
    timeoutMs: 10_000,
  } satisfies ResolvedTtsConfig;
  const auth = {
    apiKey: "key",
    source: "test",
    mode: "api-key",
  } as const;
  const assistant = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  } satisfies AssistantMessage;
  const deps: NonNullable<Parameters<typeof summarizeText>[1]> = {
    completeSimple: vi.fn(async () => assistant),
    prepareSimpleCompletionModel: vi.fn(async () => ({ model, auth })),
    requireApiKey: vi.fn(() => "key"),
  };
  return { config, deps };
}

describe("TTS core", () => {
  it("clamps oversized summarization timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { config, deps } = createSummarizeTextFixture([
        { type: "text", text: "Short summary." },
      ]);

      const result = await summarizeText(
        {
          text: "Long text that should be summarized for speech.",
          targetLength: 120,
          cfg: {},
          config,
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        },
        deps,
      );

      expect(result.summary).toBe("Short summary.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("strips assistant scaffolding before returning summaries for speech", async () => {
    const { config, deps } = createSummarizeTextFixture([
      {
        type: "text",
        text: [
          "The user wants me to summarize the provided text for audio.",
          "I need to keep the key points.",
          "Let me craft a summary.",
          "<think>",
          "Hidden reasoning should not be spoken.",
          "</think>",
          "<|assistant|>",
          '<tool_call>{"name":"noop"}</tool_call>',
          "Concise audible summary.",
          "<text_to_summarize>",
          "Original text should not be spoken again.",
          "</text_to_summarize>",
        ].join("\n"),
      },
    ]);

    const result = await summarizeText(
      {
        text: "Long text that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: 10_000,
      },
      deps,
    );

    expect(result.summary).toBe("Concise audible summary.");
    expect(result.outputLength).toBe("Concise audible summary.".length);
  });

  it("preserves valid leading first-person summary prose", async () => {
    const { config, deps } = createSummarizeTextFixture([
      {
        type: "text",
        text: "I need to keep taking my medicine every morning. My doctor also moved the appointment to Friday.",
      },
    ]);

    const result = await summarizeText(
      {
        text: "Long text that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: 10_000,
      },
      deps,
    );

    expect(result.summary).toBe(
      "I need to keep taking my medicine every morning. My doctor also moved the appointment to Friday.",
    );
    expect(result.outputLength).toBe(result.summary.length);
  });

  it("preserves valid summary prose that starts with a user summary request", async () => {
    const { config, deps } = createSummarizeTextFixture([
      {
        type: "text",
        text: "The user asked me to summarize the deployment plan. The release moves to Friday.",
      },
    ]);

    const result = await summarizeText(
      {
        text: "Long text that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: 10_000,
      },
      deps,
    );

    expect(result.summary).toBe(
      "The user asked me to summarize the deployment plan. The release moves to Friday.",
    );
    expect(result.outputLength).toBe(result.summary.length);
  });

  it("preserves summary content after colon-style prompt echoes", async () => {
    const { config, deps } = createSummarizeTextFixture([
      {
        type: "text",
        text: "The user asked me to summarize: deploy was delayed until Friday.",
      },
    ]);

    const result = await summarizeText(
      {
        text: "Long text that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: 10_000,
      },
      deps,
    );

    expect(result.summary).toBe("deploy was delayed until Friday.");
    expect(result.outputLength).toBe(result.summary.length);
  });

  it("caps overlong summaries at the requested speech length", async () => {
    const { config, deps } = createSummarizeTextFixture([
      {
        type: "text",
        text: `Audible summary ${"word ".repeat(80)}`,
      },
    ]);

    const result = await summarizeText(
      {
        text: "Long text that should be summarized for speech.",
        targetLength: 120,
        cfg: {},
        config,
        timeoutMs: 10_000,
      },
      deps,
    );

    expect(result.summary.length).toBeLessThanOrEqual(120);
    expect(result.summary).toMatch(/\.\.\.$/);
    expect(result.outputLength).toBe(result.summary.length);
  });
});
