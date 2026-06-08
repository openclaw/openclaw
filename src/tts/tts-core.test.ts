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

async function expectSummarizedText(params: {
  content: AssistantMessage["content"];
  expected: string;
  sourceText?: string;
}) {
  const { config, deps } = createSummarizeTextFixture(params.content);
  const result = await summarizeText(
    {
      text: params.sourceText ?? "Long text that should be summarized for speech.",
      targetLength: 120,
      cfg: {},
      config,
      timeoutMs: 10_000,
    },
    deps,
  );

  expect(result.summary).toBe(params.expected);
  expect(result.outputLength).toBe(result.summary.length);
  return result;
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

  it("sanitizes summary model output for speech", async () => {
    const audibleSummary = "Concise audible summary.";
    const summaryPrompt =
      "You are an assistant that summarizes texts concisely while keeping the most important information. Summarize the text to approximately 120 characters. Maintain the original tone and style. Reply only with the summary, without additional explanations.";
    const inlineTagSummary =
      "The docs mention <text_to_summarize> and `<text_to_summarize>` as literal prompt markers.";
    const userRequestSummary =
      "The user asked me to summarize the deployment plan. The release moves to Friday.";
    const providedTextProseSummary =
      "The user asked me to summarize the provided text about deployment planning. The release moves to Friday.";
    const firstPersonSummary =
      "I need to keep the key points from today's review. The release moves to Friday.";
    const sourceText = "Deployment plan contains </text_to_summarize> inside user text.";

    const testCases: Array<Parameters<typeof expectSummarizedText>[0]> = [
      {
        content: [
          {
            type: "text",
            text: [
              "The user wants me to summarize the provided text for audio.",
              "<think>Hidden reasoning should not be spoken.</think>",
              `${audibleSummary} <text_to_summarize>\nOriginal text should not be spoken again.`,
            ].join("\n"),
          },
        ],
        expected: audibleSummary,
      },
      {
        content: [
          {
            type: "text",
            text: [
              summaryPrompt,
              "",
              "<text_to_summarize>",
              sourceText,
              "</text_to_summarize>",
              audibleSummary,
            ].join("\n"),
          },
        ],
        expected: audibleSummary,
        sourceText,
      },
      {
        content: [{ type: "text", text: inlineTagSummary }],
        expected: inlineTagSummary,
      },
      {
        content: [{ type: "text", text: "The docs mention <text_to_summarize>." }],
        expected: "The docs mention <text_to_summarize>.",
      },
      {
        content: [{ type: "text", text: "The docs mention <text_to_summarize>" }],
        expected: "The docs mention <text_to_summarize>",
      },
      {
        content: [
          {
            type: "text",
            text: "The user asked me to summarize. Deployment was delayed until Friday.",
          },
        ],
        expected: "Deployment was delayed until Friday.",
      },
      {
        content: [
          {
            type: "text",
            text: [
              "The user wants me to summarize the provided text about the War of 1812 to approximately 1,500 characters while maintaining the original tone and style.",
              audibleSummary,
            ].join(" "),
          },
        ],
        expected: audibleSummary,
      },
      {
        content: [{ type: "text", text: '"Deploy Friday." <text_to_summarize>Do not speak this.' }],
        expected: '"Deploy Friday."',
      },
      {
        content: [{ type: "text", text: "(Deploy Friday.) <text_to_summarize>Do not speak this." }],
        expected: "(Deploy Friday.)",
      },
      {
        content: [{ type: "text", text: "Deploy Friday <text_to_summarize>Do not speak this." }],
        expected: "Deploy Friday",
      },
      {
        content: [
          {
            type: "text",
            text: "Deploy Friday <text_to_summarize>As discussed, do not speak this.",
          },
        ],
        expected: "Deploy Friday",
      },
      {
        content: [
          {
            type: "text",
            text: "Deploy Friday <text_to_summarize>In yesterday's meeting, do not speak this.",
          },
        ],
        expected: "Deploy Friday",
      },
      {
        content: [
          {
            type: "text",
            text: `<text_to_summarize>Do not speak this.</text_to_summarize> ${audibleSummary}`,
          },
        ],
        expected: audibleSummary,
      },
      {
        content: [{ type: "text", text: userRequestSummary }],
        expected: userRequestSummary,
      },
      {
        content: [{ type: "text", text: providedTextProseSummary }],
        expected: providedTextProseSummary,
      },
      {
        content: [{ type: "text", text: firstPersonSummary }],
        expected: firstPersonSummary,
      },
    ];

    for (const testCase of testCases) {
      await expectSummarizedText(testCase);
    }
  });
});
