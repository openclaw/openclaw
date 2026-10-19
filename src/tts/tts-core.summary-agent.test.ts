import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-types.js";

// Only the network call is stubbed; model acquisition and selection run for real.
const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());

vi.mock("../agents/simple-completion-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/simple-completion-runtime.js")>()),
  completeWithPreparedSimpleCompletionModel,
}));

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

const ttsConfig = {
  auto: "inbound",
  mode: "final",
  provider: "test-provider",
  providerSource: "config",
  personas: {},
  modelOverrides: modelOverridePolicy,
  providerConfigs: {},
  maxTextLength: 10_000,
  timeoutMs: 10_000,
} satisfies ResolvedTtsConfig;

describe("TTS summary model in a multi-agent setup", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    completeWithPreparedSimpleCompletionModel.mockReset();
  });

  it("summarizes for the responding agent through real selection using the global default model", async () => {
    completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce({
      content: [{ type: "text", text: "Short spoken summary." }],
    });
    const cfg = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4-mini" } },
        entries: {
          main: { model: "anthropic/claude-sonnet-4-5" },
          work: { model: "anthropic/claude-opus-4-1" },
        },
      },
    } as OpenClawConfig;

    const result = await summarizeText({
      text: "Long text that should be summarized for speech. ".repeat(10),
      targetLength: 120,
      cfg,
      config: ttsConfig,
      timeoutMs: 10_000,
      agentId: "work",
    });

    expect(result.summary).toBe("Short spoken summary.");
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ provider: "openai", id: "gpt-5.4-mini" }),
      }),
    );
  });
});
