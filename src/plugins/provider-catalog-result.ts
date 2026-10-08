import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import {
  copyArrayEntries,
  copyRecordEntries,
  isRecordWithoutThrowing,
  readRecordValue,
} from "../shared/safe-record.js";
import type { ProviderCatalogOutcome, ProviderCatalogResult } from "./types.js";

const PROVIDER_CATALOG_OUTCOME_STATUSES = new Set<ProviderCatalogOutcome["status"]>([
  "ready",
  "auth-rejected",
  "unavailable",
]);

const MODEL_PROVIDER_CONFIG_KEYS = [
  "apiKey",
  "auth",
  "api",
  "maxTokens",
  "timeoutSeconds",
  "region",
  "injectNumCtxForOpenAICompat",
  "params",
  "agentRuntime",
  "localService",
  "headers",
  "authHeader",
  "request",
] as const satisfies readonly (keyof ModelProviderConfig)[];

const MODEL_DEFINITION_CONFIG_KEYS = [
  "api",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "contextTokens",
  "maxTokens",
  "thinkingLevelMap",
  "params",
  "agentRuntime",
  "headers",
  "compat",
  "mediaInput",
  "metadataSource",
] as const satisfies readonly (keyof ModelDefinitionConfig)[];

/** Projection of a provider catalog result into provider config entries. */
type ProviderCatalogResultProjection =
  | { kind: "provider"; provider: ModelProviderConfig }
  | { kind: "providers"; providers: Array<[string, ModelProviderConfig]> }
  | { kind: "empty" };

/** Copies provider config data out of a provider catalog result. */
export function copyProviderCatalogResultProjection(
  result: ProviderCatalogResult,
): ProviderCatalogResultProjection {
  const provider = copyProviderCatalogProviderConfig(readRecordValue(result, "provider"));
  if (provider) {
    return { kind: "provider", provider };
  }

  const providers = copyRecordEntries<ModelProviderConfig>(
    readRecordValue(result, "providers"),
  ).flatMap(([providerId, providerConfig]) => {
    const copied = copyProviderCatalogProviderConfig(providerConfig);
    return copied ? [[providerId, copied] as [string, ModelProviderConfig]] : [];
  });
  return providers.length > 0 ? { kind: "providers", providers } : { kind: "empty" };
}

function copyModelServiceTiers(
  value: unknown,
): NonNullable<ProviderCatalogOutcome["modelServiceTiers"]> {
  return copyArrayEntries(value).flatMap((entry) => {
    const modelId = readRecordValue(entry, "modelId");
    const runtimeId = readRecordValue(entry, "runtimeId");
    const api = readRecordValue(entry, "api");
    const baseUrl = readRecordValue(entry, "baseUrl");
    const tiers = readRecordValue(entry, "serviceTiers");
    if (
      typeof modelId !== "string" ||
      !modelId.trim() ||
      typeof runtimeId !== "string" ||
      !runtimeId.trim() ||
      typeof api !== "string" ||
      !api.trim() ||
      typeof baseUrl !== "string" ||
      !baseUrl.trim() ||
      !Array.isArray(tiers)
    ) {
      return [];
    }
    const serviceTiers = copyArrayEntries(tiers);
    if (
      !serviceTiers.every(
        (tier): tier is string => typeof tier === "string" && Boolean(tier.trim()),
      )
    ) {
      return [];
    }
    return [
      {
        modelId: modelId.trim(),
        runtimeId: runtimeId.trim(),
        api: api.trim(),
        baseUrl: baseUrl.trim(),
        serviceTiers: [...new Set(serviceTiers.map((tier) => tier.trim()))],
      },
    ];
  });
}

/** Copies valid, secret-free provider outcomes out of a catalog hook result. */
export function copyProviderCatalogOutcomes(
  result: { outcomes?: readonly ProviderCatalogOutcome[] } | null | undefined,
): ProviderCatalogOutcome[] {
  return copyArrayEntries(readRecordValue(result, "outcomes")).flatMap((entry) => {
    if (!isRecordWithoutThrowing(entry)) {
      return [];
    }
    const provider = readRecordValue(entry, "provider");
    const profileId = readRecordValue(entry, "profileId");
    const rejectionScope = readRecordValue(entry, "rejectionScope");
    const status = readRecordValue(entry, "status");
    const rawModelOrder = readRecordValue(entry, "modelOrder");
    if (
      typeof provider !== "string" ||
      provider.trim().length === 0 ||
      (profileId !== undefined &&
        (typeof profileId !== "string" || profileId.trim().length === 0)) ||
      (rejectionScope !== undefined && rejectionScope !== "catalog") ||
      typeof status !== "string" ||
      !PROVIDER_CATALOG_OUTCOME_STATUSES.has(status as ProviderCatalogOutcome["status"])
    ) {
      return [];
    }
    const modelOrder =
      status === "ready" && rawModelOrder !== undefined
        ? [
            ...new Set(
              copyArrayEntries(rawModelOrder).flatMap((value) =>
                typeof value === "string" && value.trim() ? [value.trim()] : [],
              ),
            ),
          ]
        : [];
    return [
      {
        provider: provider.trim(),
        ...(typeof profileId === "string" ? { profileId: profileId.trim() } : {}),
        ...(rejectionScope === "catalog" ? { rejectionScope } : {}),
        status: status as ProviderCatalogOutcome["status"],
        ...(status === "ready" && readRecordValue(entry, "modelServiceTiers") !== undefined
          ? {
              modelServiceTiers: copyModelServiceTiers(readRecordValue(entry, "modelServiceTiers")),
            }
          : {}),
        ...(modelOrder.length > 0 ? { modelOrder } : {}),
      },
    ];
  });
}

/** Copies provider catalog result entries, using providerId for single-provider results. */
export function copyProviderCatalogResultEntries(params: {
  providerId: string;
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const projection = copyProviderCatalogResultProjection(params.result);
  if (projection.kind === "provider") {
    return [[params.providerId, projection.provider]];
  }
  return projection.kind === "providers" ? projection.providers : [];
}

function copyProviderCatalogModel(model: unknown): ModelDefinitionConfig | undefined {
  if (!isRecordWithoutThrowing(model)) {
    return undefined;
  }
  const id = readRecordValue(model, "id");
  const name = readRecordValue(model, "name");
  if (typeof id !== "string") {
    return undefined;
  }

  const copied: Partial<ModelDefinitionConfig> = {
    id,
    name: typeof name === "string" ? name : id,
  };
  for (const key of MODEL_DEFINITION_CONFIG_KEYS) {
    const value = readRecordValue(model, key);
    if (value !== undefined) {
      (copied as Record<string, unknown>)[key] = value;
    }
  }
  return copied as ModelDefinitionConfig;
}

/** Copies the supported provider config fields from a provider catalog result. */
function copyProviderCatalogProviderConfig(
  providerConfig: unknown,
): ModelProviderConfig | undefined {
  if (!isRecordWithoutThrowing(providerConfig)) {
    return undefined;
  }

  const baseUrl = readRecordValue(providerConfig, "baseUrl");
  if (typeof baseUrl !== "string") {
    return undefined;
  }

  const copied: Partial<ModelProviderConfig> = {
    baseUrl,
    models: copyArrayEntries(readRecordValue(providerConfig, "models")).flatMap((entry) => {
      const model = copyProviderCatalogModel(entry);
      return model ? [model] : [];
    }),
  };
  for (const key of MODEL_PROVIDER_CONFIG_KEYS) {
    const value = readRecordValue(providerConfig, key);
    if (value !== undefined) {
      (copied as Record<string, unknown>)[key] = value;
    }
  }
  return copied as ModelProviderConfig;
}
