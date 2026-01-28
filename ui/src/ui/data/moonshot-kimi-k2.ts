export const MOONSHOT_KIMI_K2_DEFAULT_ID = "kimi-k2-0905-preview";
export const MOONSHOT_KIMI_K2_CONTEXT_WINDOW = 256000;
export const MOONSHOT_KIMI_K2_MAX_TOKENS = 8192;
export const MOONSHOT_KIMI_K2_INPUT = ["text"] as const;
export const MOONSHOT_KIMI_K2_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

export const MOONSHOT_KIMI_K2_MODELS = [
  {
    id: "kimi-k2-0905-preview",
    name: "Kimi K2 0905 Preview",
    alias: "Kimi K2",
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
