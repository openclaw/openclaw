import type { TtsEngine } from "./engine.js";
import { EdgeTtsEngine } from "./engines/edge.js";
import { ElevenLabsTtsEngine } from "./engines/elevenlabs.js";
import { OpenAiTtsEngine } from "./engines/openai.js";
import type { ResolvedTtsConfig } from "./tts.js";

/**
 * Resolve the API key for a given provider from config + env.
 * Mirrors the original `resolveTtsApiKey` logic but scoped to engine creation.
 */
function resolveApiKey(
  config: ResolvedTtsConfig,
  provider: "openai" | "elevenlabs",
): string | undefined {
  if (provider === "elevenlabs") {
    return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
  }
  return config.openai.apiKey || process.env.OPENAI_API_KEY;
}

export function createTtsEngines(config: ResolvedTtsConfig): Map<string, TtsEngine> {
  const engines = new Map<string, TtsEngine>();

  engines.set("openai", new OpenAiTtsEngine(config.openai, resolveApiKey(config, "openai")));
  engines.set(
    "elevenlabs",
    new ElevenLabsTtsEngine(config.elevenlabs, resolveApiKey(config, "elevenlabs")),
  );
  engines.set("edge", new EdgeTtsEngine(config.edge));

  return engines;
}
