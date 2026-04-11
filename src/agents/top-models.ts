/**
 * Curated list of top Venice AI models shown in quick-pick UIs.
 *
 * These are the featured models displayed in the model picker dropdown
 * before the "More models..." option. Ordered by recommendation priority.
 */
export const VENICE_TOP_MODELS = [
  { ref: "venice/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { ref: "venice/claude-opus-4-6", label: "Claude Opus 4.6" },
  { ref: "venice/openai-gpt-54-pro", label: "GPT-5.4 Pro" },
  { ref: "venice/grok-41-fast", label: "Grok 4.1" },
  { ref: "venice/gemini-3-1-pro-preview", label: "Gemini 3.1 Pro" },
] as const;

export type TopModelEntry = (typeof VENICE_TOP_MODELS)[number];
