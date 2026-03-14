import type { TtsEngine, TtsSynthesizeRequest, TtsSynthesizeResult } from "../engine.js";
import {
  isValidOpenAIModel,
  isValidOpenAIVoice,
  resolveOpenAITtsInstructions,
} from "../tts-core.js";
import type { ResolvedTtsConfig } from "../tts.js";

export class OpenAiTtsEngine implements TtsEngine {
  readonly id = "openai";

  constructor(
    private readonly config: ResolvedTtsConfig["openai"],
    private readonly apiKey: string | undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsTelephony(): boolean {
    return true;
  }

  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI TTS: no API key");
    }

    const model = request.overrides?.openai?.model ?? this.config.model;
    const voice = request.overrides?.openai?.voice ?? this.config.voice;
    const { baseUrl, speed, instructions } = this.config;
    const effectiveInstructions = resolveOpenAITtsInstructions(model, instructions);

    if (!isValidOpenAIModel(model, baseUrl)) {
      throw new Error(`Invalid model: ${model}`);
    }
    if (!isValidOpenAIVoice(voice, baseUrl)) {
      throw new Error(`Invalid voice: ${voice}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: request.text,
          voice,
          response_format: request.outputFormat,
          ...(speed != null && { speed }),
          ...(effectiveInstructions != null && { instructions: effectiveInstructions }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI TTS API error (${response.status})`);
      }

      return {
        audio: Buffer.from(await response.arrayBuffer()),
        format: request.outputFormat,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
