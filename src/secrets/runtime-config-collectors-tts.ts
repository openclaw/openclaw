import {
  collectSecretInputAssignment,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

function collectProviderApiKeyAssignment(params: {
  providerId: string;
  providerConfig: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  collectSecretInputAssignment({
    value: params.providerConfig.apiKey,
    path: `${params.pathPrefix}.providers.${params.providerId}.apiKey`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: params.active,
    inactiveReason: params.inactiveReason,
    apply: (value) => {
      params.providerConfig.apiKey = value;
    },
  });
}

export function collectTtsApiKeyAssignments(params: {
  tts: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active?: boolean;
  inactiveReason?: string;
}): void {
  const providers = params.tts.providers;
  if (isRecord(providers)) {
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (!isRecord(providerConfig)) {
        continue;
      }
      collectProviderApiKeyAssignment({
        providerId,
        providerConfig,
        pathPrefix: params.pathPrefix,
        defaults: params.defaults,
        context: params.context,
        active: params.active,
        inactiveReason: params.inactiveReason,
      });
    }
    return;
  }

  // Legacy compatibility until migrated configs have been rewritten on disk.
  const legacyProviders = ["elevenlabs", "openai"] as const;
  for (const providerId of legacyProviders) {
    const providerConfig = params.tts[providerId];
    if (!isRecord(providerConfig)) {
      continue;
    }
    collectSecretInputAssignment({
      value: providerConfig.apiKey,
      path: `${params.pathPrefix}.${providerId}.apiKey`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      apply: (value) => {
        providerConfig.apiKey = value;
      },
    });
  }
}
