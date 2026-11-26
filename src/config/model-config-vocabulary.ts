import {
  MODEL_DATA_APIS,
  MODEL_DATA_THINKING_FORMATS,
} from "../../packages/llm-core/src/model-data.js";
import type { OpenAICompletionsCompat } from "../llm/types.js";
import { isStringOption } from "../utils/string-readers.js";

/** Provider API adapter ids accepted by model/provider config and schema generation. */
export const MODEL_APIS = [...MODEL_DATA_APIS] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

/** Trusted total-parameter size classes used for Agent Profile selection. */
export const MODEL_SIZE_CLASSES = ["tiny", "small", "medium", "large"] as const;

export type ModelSizeClass = (typeof MODEL_SIZE_CLASSES)[number];

export type SupportedThinkingFormat =
  | NonNullable<OpenAICompletionsCompat["thinkingFormat"]>
  | "deepseek"
  | "openrouter"
  | "together";

/** Thinking/reasoning payload dialects emitted by OpenAI-compatible providers. */
export const MODEL_THINKING_FORMATS = [
  ...MODEL_DATA_THINKING_FORMATS,
] as const satisfies readonly SupportedThinkingFormat[];

/** Runtime guard for config-provided thinking format strings. */
export function isModelThinkingFormat(value: string): value is SupportedThinkingFormat {
  return isStringOption(value, MODEL_THINKING_FORMATS);
}
