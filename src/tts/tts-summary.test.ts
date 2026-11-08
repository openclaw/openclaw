import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import { createZeroUsage } from "../../packages/ai/src/usage.test-support.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import * as globals from "../globals.js";
import type { AssistantMessage } from "../llm/types.js";
import { summarizeText } from "./tts-core.js";
import * as tts from "./tts-runtime.test-support.js";

type Completion =
  typeof import("../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;
const completion = vi.hoisted(() => ({
  complete: vi.fn<Completion>(),
  prepare: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  completeWithPreparedSimpleCompletionModel: completion.complete,
  acquireSimpleCompletionModelWithSelection: completion.prepare,
}));

const model = makeProviderModelFixture<"openai-completions">({
  id: "test-summary",
  provider: "test-provider",
  api: "openai-completions",
  baseUrl: "https://summary.example.test/v1",
  reasoning: true,
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return makeAgentAssistantMessage({
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
  });
}

const originalText = "The original reply remains visible. ".repeat(60);
const persistAudio = vi.fn(async () => "/tmp/synthetic-summary.ogg");
let cfg: tts.OpenClawConfig;

beforeEach(() => {
  cfg = {
    ...tts.createTtsConfig(`openclaw-tts-summary-${randomUUID()}`),
    agents: { defaults: { model: { primary: "test-provider/test-summary" } } },
    tts: { auto: "always", provider: "mock", summaryModel: "test-provider/test-summary" },
  };
  tts.installSpeechProviders([tts.createMockSpeechProvider()]);
  completion.complete.mockReset();
  completion.prepare.mockReturnValue({
    async [Symbol.asyncDispose]() {},
    model,
    auth: { apiKey: "synthetic-test-key", source: "test", mode: "api-key" },
    release: () => {},
  });
  tts.synthesizeMock.mockClear();
  tts.prepareSynthesisMock.mockClear();
  persistAudio.mockClear();
});

afterEach(() => {
  tts.setTtsMachinePrefsPathResolver();
  tts.clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function summarize() {
  return summarizeText({
    text: originalText,
    targetLength: 120,
    cfg,
    config: tts.resolveTtsConfig(cfg),
    timeoutMs: 1000,
  });
}

function applySummaryToSpeech(text = originalText) {
  return tts.maybeApplyTtsToPayloadCore(
    { payload: { text }, cfg, channel: "telegram", kind: "final" },
    persistAudio,
  );
}

const completeText = (text: string) =>
  completion.complete.mockResolvedValue(assistant([textBlock(text)]));
const textBlock = (text: string) => ({ type: "text" as const, text });
const expectSpoken = (text: string) =>
  expect(tts.synthesizeMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));

describe("TTS summary visible text", () => {
  it.each([
    {
      content: [
        { type: "thinking", thinking: "Separate private reasoning" },
        textBlock("<think>Hidden reasoning"),
        textBlock("continues</think>Spoken summary."),
      ],
    },
    {
      content: [
        textBlock('<tool_call>{"name":"private_tool"}</tool_call><|im_end|>Spoken summary.'),
      ],
    },
  ] satisfies Array<{ content: AssistantMessage["content"] }>)(
    "returns only visible summary text: %j",
    async ({ content }) => {
      completion.complete.mockResolvedValue(assistant(content));
      const result = await summarize();
      expect(result).toMatchObject({
        summary: "Spoken summary.",
        outputLength: 15,
        inputLength: originalText.length,
      });
    },
  );

  it("does not recover unterminated reasoning as summary text at the transport boundary", async () => {
    completion.complete.mockImplementation(async ({ options }) => {
      const output = assistant([]);
      async function* chunks() {
        yield {
          id: "summary-chunk",
          object: "chat.completion.chunk" as const,
          created: 0,
          model: model.id,
          choices: [
            {
              index: 0,
              delta: { content: "<think>Private reasoning without a close tag" },
              finish_reason: "stop" as const,
              logprobs: null,
            },
          ],
        };
      }
      await processCompletionsStream(
        chunks(),
        output,
        model,
        { push() {} },
        {
          strictReasoningTags: options?.strictReasoningTags,
        },
      );
      return output;
    });
    await expect(summarize()).rejects.toThrow("No summary returned");
  });

  it("hands the sanitized summary to synthesis while preserving the visible original reply", async () => {
    completeText("<think>Private reasoning</think>Spoken summary.");
    const result = await applySummaryToSpeech();
    expectSpoken("Spoken summary.");
    expect(result).toMatchObject({
      text: originalText,
      spokenText: "Spoken summary.",
      mediaUrl: "/tmp/synthetic-summary.ogg",
    });
  });

  it.each([
    ["no visible content", 1500],
    ["provider text echo", 1500],
    ["lower config limit", 1000],
  ] as const)("truncates fallback for %s without logging content", async (failure, limit) => {
    const text = limit === 1000 ? "x".repeat(1200) : originalText;
    if (limit === 1000) {
      cfg = { ...cfg, tts: { ...cfg.tts, maxTextLength: limit } };
    }
    const log = vi.spyOn(globals, "logVerbose").mockImplementation(() => {});
    if (failure === "provider text echo") {
      completion.complete.mockImplementationOnce(async ({ context }) => {
        throw new Error(JSON.stringify(context.messages));
      });
    } else {
      completeText("<think>Private only</think>");
    }
    const result = await applySummaryToSpeech(text);
    expectSpoken(`${text.slice(0, limit - 3)}...`);
    expect(result).toMatchObject({ text, mediaUrl: "/tmp/synthetic-summary.ogg" });
    expect(log).toHaveBeenCalledWith("TTS: summarization failed, truncating instead.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("The original reply remains visible.");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Private only");
  });
});
