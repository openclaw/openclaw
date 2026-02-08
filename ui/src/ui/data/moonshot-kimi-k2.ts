export const MOONSHOT_KIMI_K2_DEFAULT_ID = "kimi-k2.5";
export const MOONSHOT_KIMI_K2_CONTEXT_WINDOW = 256000;
export const MOONSHOT_KIMI_K2_MAX_TOKENS = 8192;
export const MOONSHOT_KIMI_K2_INPUT = ["text"] as const;
export const MOONSHOT_KIMI_K2_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

// Kimi Coding constants - use these in KIMI_CODING_MODELS
export const KIMI_CODING_DEFAULT_ID = "k2p5";
export const KIMI_CODING_CONTEXT_WINDOW = 256000;
export const KIMI_CODING_MAX_TOKENS = 8192;
export const KIMI_CODING_INPUT = ["text"] as const;
export const KIMI_CODING_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export const MOONSHOT_KIMI_K2_MODELS = [
  {
    id: "kimi-k2-0905-preview",
    name: "Kimi K2 0905 Preview",
    alias: "Kimi K2 0905",
    reasoning: false,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    alias: "Kimi K2.5",
    reasoning: false,
  },
  {
    id: "kimi-k2-turbo-preview",
    name: "Kimi K2 Turbo",
    alias: "Kimi K2 Turbo",
    reasoning: false,
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    alias: "Kimi K2 Thinking",
    reasoning: true,
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    alias: "Kimi K2 Thinking Turbo",
    reasoning: true,
  },
] as const;

export type MoonshotKimiK2Model = (typeof MOONSHOT_KIMI_K2_MODELS)[number];

// Use constants from above to avoid inconsistency
export const KIMI_CODING_MODELS = [
  {
    id: KIMI_CODING_DEFAULT_ID,
    name: "Kimi Code K2.5",
    alias: "Kimi Code K2.5",
    reasoning: false,
  },
] as const;

export type KimiCodingModel = (typeof KIMI_CODING_MODELS)[number];
