export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";

/** Header name for Kilocode organization ID */
export const KILOCODE_ORG_ID_HEADER = "X-KILOCODE-ORGANIZATIONID";

/** Environment variable name for Kilocode organization ID */
export const KILOCODE_ORG_ID_ENV_VAR = "KILOCODE_ORG_ID";

/**
 * Resolve the Kilocode organization ID.
 *
 * Resolution order (highest priority first):
 * 1. Provider config `organizationId` field: `models.providers.kilocode.organizationId`
 * 2. Provider config headers: `models.providers.kilocode.headers["X-KILOCODE-ORGANIZATIONID"]`
 * 3. Environment variable: `KILOCODE_ORG_ID`
 */
export function resolveKilocodeOrgId(providerConfig?: {
  organizationId?: string;
  headers?: Record<string, unknown>;
}): string | undefined {
  const fromField = providerConfig?.organizationId?.trim();
  if (fromField) {
    return fromField;
  }
  const fromHeaders = providerConfig?.headers?.[KILOCODE_ORG_ID_HEADER];
  if (typeof fromHeaders === "string" && fromHeaders.trim()) {
    return fromHeaders.trim();
  }
  const fromEnv = process.env[KILOCODE_ORG_ID_ENV_VAR]?.trim();
  return fromEnv || undefined;
}

export const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
export const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
export type KilocodeModelCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};
/**
 * Static fallback catalog — used by the sync setup path and as a
 * fallback when dynamic model discovery from the gateway API fails.
 * The full model list is fetched dynamically by {@link discoverKilocodeModels}
 * in `src/agents/kilocode-models.ts`.
 */
export const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[] = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 128000,
  },
];
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
