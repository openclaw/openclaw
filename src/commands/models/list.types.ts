/** Rate limit information extracted from provider HTTP response headers. */
export type RateLimitInfo = {
  /** Requests remaining in current window. */
  remainingRequests?: number;
  /** Total request limit per window. */
  limitRequests?: number;
  /** Tokens remaining in current window. */
  remainingTokens?: number;
  /** Total token limit per window. */
  limitTokens?: number;
  /** When the request limit resets (ISO 8601 or duration string). */
  resetRequests?: string;
  /** When the token limit resets (ISO 8601 or duration string). */
  resetTokens?: string;
};

export type ConfiguredEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
};

export type ModelRow = {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
  missing: boolean;
};

export type ProviderAuthOverview = {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "missing";
    detail: string;
  };
  profiles: {
    count: number;
    oauth: number;
    token: number;
    apiKey: number;
    labels: string[];
  };
  env?: { value: string; source: string };
  modelsJson?: { value: string; source: string };
};
