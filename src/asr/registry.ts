import { normalizeMediaProviderId } from "../media-understanding/providers/index.js";
import type { AsrEngine } from "./engine.js";
import { DeepgramAsrEngine } from "./engines/deepgram.js";
import { GoogleAsrEngine } from "./engines/google.js";
import { GroqAsrEngine } from "./engines/groq.js";
import { MistralAsrEngine } from "./engines/mistral.js";
import { OpenAiAsrEngine } from "./engines/openai.js";

const BUILTIN_ENGINES: AsrEngine[] = [
  new GroqAsrEngine(),
  new OpenAiAsrEngine(),
  new DeepgramAsrEngine(),
  new GoogleAsrEngine(),
  new MistralAsrEngine(),
];

export type AsrEngineRegistry = Map<string, AsrEngine>;

export function buildAsrEngineRegistry(overrides?: Record<string, AsrEngine>): AsrEngineRegistry {
  const registry: AsrEngineRegistry = new Map();
  for (const engine of BUILTIN_ENGINES) {
    registry.set(normalizeAsrEngineId(engine.id), engine);
  }
  if (overrides) {
    for (const [key, engine] of Object.entries(overrides)) {
      registry.set(normalizeAsrEngineId(key), engine);
    }
  }
  return registry;
}

export function getAsrEngine(id: string, registry: AsrEngineRegistry): AsrEngine | undefined {
  return registry.get(normalizeAsrEngineId(id));
}

/**
 * Re-use the same ID normalization as the media-understanding provider
 * registry so that "gemini" → "google", "z.ai" → "zai", etc. all resolve
 * consistently.
 */
export function normalizeAsrEngineId(id: string): string {
  return normalizeMediaProviderId(id);
}
