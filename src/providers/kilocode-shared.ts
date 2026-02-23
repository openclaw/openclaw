export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Claude Opus 4.6";
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 200000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 8192;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
