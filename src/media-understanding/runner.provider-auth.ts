// Resolves media provider credentials and owns cancellation-aware API-key retries.
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import {
  providerOperationRetryConfig,
  resolveTransientProviderRetryOptions,
} from "../provider-runtime/operation-retry.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenAiAudioAuthModelApi } from "./openai-audio-api.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingCapability,
  MediaUnderstandingProvider,
} from "./types.js";

const loadModelAuth = createLazyRuntimeModule(async () => await import("../agents/model-auth.js"));

type ProviderExecutionAuth =
  | {
      kind: "api-key";
      apiKeys: string[];
      source?: string;
    }
  | {
      kind: "none";
      source: string;
    };

export function executeProviderRequest<T>(
  provider: string,
  auth: ProviderExecutionAuth,
  execute: (auth: Pick<AudioTranscriptionRequest, "apiKey" | "auth">) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const retry = resolveTransientProviderRetryOptions(providerOperationRetryConfig("read"));
  return auth.kind === "api-key"
    ? executeWithApiKeyRotation({
        provider,
        apiKeys: auth.apiKeys,
        transientRetry: retry && { ...retry, ...(signal ? { signal } : {}) },
        execute: (apiKey) =>
          execute({
            apiKey,
            auth: { kind: "api-key", apiKey, source: auth.source },
          }),
      })
    : execute({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        auth: { kind: "none", source: auth.source ?? `provider:${provider}` },
      });
}

export async function resolveProviderExecutionAuth(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  agentDir?: string;
  workspaceDir?: string;
  signal?: AbortSignal;
  providerId: string;
  provider?: MediaUnderstandingProvider;
}): Promise<ProviderExecutionAuth> {
  const apiKeyAuth = (apiKey: string, source?: string): ProviderExecutionAuth => ({
    kind: "api-key",
    apiKeys: collectProviderApiKeysForExecution({
      provider: params.providerId,
      primaryApiKey: apiKey,
    }),
    source,
  });
  const providerConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  );
  const literalApiKey = normalizeNullableString(
    params.cfg.models?.providers?.[params.providerId]?.apiKey,
  );
  if (literalApiKey) {
    return apiKeyAuth(literalApiKey, `models.providers.${params.providerId}.apiKey`);
  }
  const { isProviderAuthError, requireApiKey, resolveApiKeyForProviderCore } =
    await loadModelAuth();
  params.signal?.throwIfAborted();
  try {
    const auth = await resolveApiKeyForProviderCore({
      provider: params.providerId,
      cfg: params.cfg,
      profileId: params.entry.profile,
      preferredProfile: params.entry.preferredProfile,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      modelApi: resolveOpenAiAudioAuthModelApi({
        capability: params.capability,
        providerId: params.providerId,
      }),
    });
    params.signal?.throwIfAborted();
    return apiKeyAuth(requireApiKey(auth, params.providerId), auth.source);
  } catch (err) {
    params.signal?.throwIfAborted();
    if (
      !isProviderAuthError(err, "missing-provider-auth") &&
      !isProviderAuthError(err, "missing-api-key")
    ) {
      throw err;
    }
    const context = {
      config: params.cfg,
      provider: params.providerId,
      providerConfig,
    };
    const providerAuth = params.provider?.resolveAuth?.(context);
    if (providerAuth?.kind === "none") {
      return providerAuth;
    }
    const keyAuth = providerAuth ?? params.provider?.resolveSyntheticAuth?.(context);
    const apiKey = keyAuth?.apiKey.trim();
    if (apiKey) {
      return apiKeyAuth(apiKey, keyAuth?.source);
    }
    throw err;
  }
}
