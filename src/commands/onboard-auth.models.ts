import type { ModelDefinitionConfig } from "../config/types.js";

// Auto-detect region based on timezone for optimal MiniMax endpoint
function detectMinimaxRegion(): "cn" | "global" {
  // Allow manual override via environment variable
  const envRegion = process.env.MINIMAX_REGION?.toLowerCase();
  if (envRegion === "cn" || envRegion === "china") {
    return "cn";
  }
  if (envRegion === "global" || envRegion === "overseas") {
    return "global";
  }

  // Auto-detect based on timezone
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // China mainland timezones
    const chinaTzs = [
      "Asia/Shanghai",
      "Asia/Chongqing",
      "Asia/Urumqi",
      "Asia/Hong_Kong",
      "Asia/Macau",
      "Asia/Taipei",
    ];
    if (chinaTzs.includes(timezone)) {
      return "cn";
    }
  } catch {
    // Fallback to global if timezone detection fails
  }

  return "global";
}

// Region-specific base URLs
const MINIMAX_BASE_URLS = {
  cn: {
    v1: "https://api.minimaxi.com/v1",
    anthropic: "https://api.minimaxi.com/anthropic",
  },
  global: {
    v1: "https://api.minimax.io/v1",
    anthropic: "https://api.minimax.io/anthropic",
  },
} as const;

// Auto-select base URL based on region
const DETECTED_REGION = detectMinimaxRegion();
export const DEFAULT_MINIMAX_BASE_URL = MINIMAX_BASE_URLS[DETECTED_REGION].v1;
export const MINIMAX_API_BASE_URL = MINIMAX_BASE_URLS[DETECTED_REGION].anthropic;
export const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
export const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
export const DEFAULT_MINIMAX_CONTEXT_WINDOW = 200000;
export const DEFAULT_MINIMAX_MAX_TOKENS = 8192;

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2-0905-preview";
export const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
export const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
export const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
export const KIMI_CODING_MODEL_ID = "k2p5";
export const KIMI_CODING_MODEL_REF = `kimi-coding/${KIMI_CODING_MODEL_ID}`;

// Pricing: MiniMax doesn't publish public rates. Override in models.json for accurate costs.
export const MINIMAX_API_COST = {
  input: 15,
  output: 60,
  cacheRead: 2,
  cacheWrite: 10,
};
export const MINIMAX_HOSTED_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MINIMAX_LM_STUDIO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MINIMAX_MODEL_CATALOG = {
  "MiniMax-M2.1": { name: "MiniMax M2.1", reasoning: false },
  "MiniMax-M2.1-lightning": {
    name: "MiniMax M2.1 Lightning",
    reasoning: false,
  },
} as const;

type MinimaxCatalogId = keyof typeof MINIMAX_MODEL_CATALOG;

export function buildMinimaxModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  maxTokens: number;
}): ModelDefinitionConfig {
  const catalog = MINIMAX_MODEL_CATALOG[params.id as MinimaxCatalogId];
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input: ["text"],
    cost: params.cost,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  };
}

export function buildMinimaxApiModelDefinition(modelId: string): ModelDefinitionConfig {
  return buildMinimaxModelDefinition({
    id: modelId,
    cost: MINIMAX_API_COST,
    contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
  });
}

export function buildMoonshotModelDefinition(): ModelDefinitionConfig {
  return {
    id: MOONSHOT_DEFAULT_MODEL_ID,
    name: "Kimi K2 0905 Preview",
    reasoning: false,
    input: ["text"],
    cost: MOONSHOT_DEFAULT_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  };
}
