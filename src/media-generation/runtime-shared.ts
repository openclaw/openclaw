import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";

export type ParsedProviderModelRef = {
  provider: string;
  model: string;
};

export function resolveCapabilityModelCandidates(params: {
  cfg: OpenClawConfig;
  modelConfig: AgentModelConfig | undefined;
  modelOverride?: string;
  parseModelRef: (raw: string | undefined) => ParsedProviderModelRef | null;
}): ParsedProviderModelRef[] {
  const candidates: ParsedProviderModelRef[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = params.parseModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(parsed);
  };

  add(params.modelOverride);
  add(resolveAgentModelPrimaryValue(params.modelConfig));
  for (const fallback of resolveAgentModelFallbackValues(params.modelConfig)) {
    add(fallback);
  }
  return candidates;
}

export function throwCapabilityGenerationFailure(params: {
  capabilityLabel: string;
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0
      ? params.attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(
    `All ${params.capabilityLabel} models failed (${params.attempts.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

export function buildNoCapabilityModelConfiguredMessage(params: {
  capabilityLabel: string;
  modelConfigKey: string;
  providers: Array<{ id: string; defaultModel?: string | null }>;
  fallbackSampleRef?: string;
}): string {
  const sampleModel = params.providers.find(
    (provider) => provider.id.trim().length > 0 && provider.defaultModel?.trim(),
  );
  const sampleRef = sampleModel
    ? `${sampleModel.id}/${sampleModel.defaultModel}`
    : (params.fallbackSampleRef ?? "<provider>/<model>");
  const authHints = params.providers
    .flatMap((provider) => {
      const envVars = getProviderEnvVars(provider.id);
      if (envVars.length === 0) {
        return [];
      }
      return [`${provider.id}: ${envVars.join(" / ")}`];
    })
    .slice(0, 3);
  return [
    `No ${params.capabilityLabel} model configured. Set agents.defaults.${params.modelConfigKey}.primary to a provider/model like "${sampleRef}".`,
    authHints.length > 0
      ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).`
      : "If you want a specific provider, also configure that provider's auth/API key first.",
  ].join(" ");
}
