import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
} from "./onboard-auth.config-shared.js";

const BEDROCK_DEFAULT_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
const BEDROCK_DEFAULT_REGION = "us-east-1";
const BEDROCK_DEFAULT_CONTEXT_WINDOW = 200_000;
const BEDROCK_DEFAULT_MAX_TOKENS = 8_192;
const BEDROCK_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const BEDROCK_DEFAULT_MODEL_REF = `amazon-bedrock/${BEDROCK_DEFAULT_MODEL_ID}`;

export type BedrockModelOption = {
  id: string;
  name: string;
};

/**
 * List all available Bedrock models including cross-region inference profiles
 * (us.anthropic.*, eu.anthropic.*, etc.) and base foundation models.
 */
export async function listBedrockModels(region: string): Promise<BedrockModelOption[]> {
  const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } =
    await import("@aws-sdk/client-bedrock");
  const client = new BedrockClient({ region });
  const models: BedrockModelOption[] = [];
  const seenIds = new Set<string>();

  // 1. List inference profiles (cross-region: us.*, eu.*, etc.)
  try {
    const profileResponse = await client.send(new ListInferenceProfilesCommand({}));
    for (const profile of profileResponse.inferenceProfileSummaries ?? []) {
      const id = profile.inferenceProfileId?.trim();
      if (!id) {
        continue;
      }
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      models.push({
        id,
        name: profile.inferenceProfileName?.trim() || id,
      });
    }
  } catch {
    // Inference profiles API may not be available — continue with foundation models.
  }

  // 2. List foundation models (base: anthropic.*, meta.*, etc.)
  try {
    const foundationResponse = await client.send(new ListFoundationModelsCommand({}));
    for (const summary of foundationResponse.modelSummaries ?? []) {
      const id = summary.modelId?.trim();
      if (!id) {
        continue;
      }
      if (seenIds.has(id)) {
        continue;
      }
      // Only include text-output, streaming-capable, active models.
      const outputMods = summary.outputModalities ?? [];
      if (!outputMods.some((m) => m.toLowerCase() === "text")) {
        continue;
      }
      if (summary.responseStreamingSupported !== true) {
        continue;
      }
      const status = summary.modelLifecycle?.status;
      if (typeof status === "string" && status.toUpperCase() !== "ACTIVE") {
        continue;
      }
      seenIds.add(id);
      models.push({
        id,
        name: summary.modelName?.trim() || id,
      });
    }
  } catch {
    // Foundation models API failed — return what we have.
  }

  return models.toSorted((a, b) => a.id.localeCompare(b.id));
}

function resolveBedrockRegion(cfg?: OpenClawConfig): string {
  const envRegion = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
  const cfgRegion = cfg?.models?.bedrockDiscovery?.region?.trim();
  return envRegion || cfgRegion || BEDROCK_DEFAULT_REGION;
}

function buildBedrockBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

function buildBedrockDefaultModelDefinition(): ModelDefinitionConfig {
  return {
    id: BEDROCK_DEFAULT_MODEL_ID,
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: BEDROCK_DEFAULT_COST,
    contextWindow: BEDROCK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: BEDROCK_DEFAULT_MAX_TOKENS,
  };
}

export function setBedrockApiKey(
  apiKey: string,
  _agentDir?: string,
): { path: string; region: string } {
  const region =
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    BEDROCK_DEFAULT_REGION;

  const result = upsertSharedEnvVar({
    key: "AWS_BEARER_TOKEN_BEDROCK",
    value: apiKey.trim(),
  });
  upsertSharedEnvVar({
    key: "AWS_REGION",
    value: region,
  });

  process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey.trim();
  process.env.AWS_REGION = region;

  return { path: result.path, region };
}

export function applyBedrockProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const region = resolveBedrockRegion(cfg);
  const models = { ...cfg.agents?.defaults?.models };
  models[BEDROCK_DEFAULT_MODEL_REF] = {
    ...models[BEDROCK_DEFAULT_MODEL_REF],
    alias: models[BEDROCK_DEFAULT_MODEL_REF]?.alias ?? "Claude Opus 4.6",
  };

  const providers = { ...cfg.models?.providers } as Record<string, ModelProviderConfig>;
  const existingProvider = providers["amazon-bedrock"];
  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const defaultModel = buildBedrockDefaultModelDefinition();
  const hasDefaultModel = existingModels.some((model) => model.id === BEDROCK_DEFAULT_MODEL_ID);
  const mergedModels = hasDefaultModel ? existingModels : [...existingModels, defaultModel];

  providers["amazon-bedrock"] = {
    ...existingProvider,
    baseUrl: buildBedrockBaseUrl(region),
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
    models: mergedModels.length > 0 ? mergedModels : [defaultModel],
  };

  const next = applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
  return {
    ...next,
    models: {
      ...next.models,
      bedrockDiscovery: {
        ...next.models?.bedrockDiscovery,
        enabled: true,
        region,
      },
    },
  };
}

export function applyBedrockDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  return applyAgentDefaultModelPrimary(cfg, modelRef);
}

export function applyBedrockConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyBedrockProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, BEDROCK_DEFAULT_MODEL_REF);
}
