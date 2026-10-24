// Media provider credentials, availability, and per-attempt execution authority.
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "../agents/api-key-rotation.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  mergeModelProviderRequestOverrides,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
} from "../agents/provider-request-config.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
} from "../config/types.tools.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  providerOperationRetryConfig,
  resolveTransientProviderRetryOptions,
} from "../provider-runtime/operation-retry.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import { assertRuntimeMediaRequestSecretOwnerAvailable } from "../secrets/runtime-media-secret-owner.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveOpenAiAudioAuthModelApi } from "./openai-audio-api.js";
import { getMediaUnderstandingProvider, normalizeMediaProviderId } from "./provider-registry.js";
import { resolveCliModelEntry } from "./resolve.js";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingCapability,
  MediaUnderstandingProvider,
} from "./types.js";

type ProviderRegistry = Map<string, MediaUnderstandingProvider>;

export function resolveProviderRequestContext(params: {
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  config?: MediaUnderstandingConfig;
  providerId: string;
}) {
  const providerConfig = findNormalizedProviderValue(
    params.cfg.models?.providers,
    params.providerId,
  );
  const baseUrl = params.entry.baseUrl ?? params.config?.baseUrl ?? providerConfig?.baseUrl;
  const mergedHeaders: Record<string, string> = {};
  for (const headers of [providerConfig?.headers, params.config?.headers, params.entry.headers]) {
    for (const [key, value] of Object.entries(headers ?? {})) {
      // Literal marker-shaped headers are valid here; discovery sanitizes its own headers.
      if (typeof value === "string") {
        mergedHeaders[key] = value;
      }
    }
  }
  const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
  const request = mergeModelProviderRequestOverrides(
    sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    sanitizeConfiguredProviderRequest(params.config?.request),
    sanitizeConfiguredProviderRequest(params.entry.request),
  );
  return { baseUrl, headers, request };
}

const loadModelAuth = createLazyRuntimeModule(async () => {
  const modelAuth = await import("../agents/model-auth.js");
  return {
    hasAvailableAuthForProvider: modelAuth.hasAvailableAuthForProvider,
    isProviderAuthError: modelAuth.isProviderAuthError,
    requireApiKey: modelAuth.requireApiKey,
    resolveApiKeyForProviderCore: modelAuth.resolveApiKeyForProviderCore,
  };
});

export async function hasProviderAuthAvailable(params: {
  capability: MediaUnderstandingCapability;
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<boolean> {
  // Literal config keys are cheap to detect; defer loading model-auth until
  // profile/env discovery is actually needed.
  if (
    normalizeNullableString(
      findNormalizedProviderValue(params.cfg?.models?.providers, params.provider)?.apiKey,
    )
  ) {
    return true;
  }
  const { hasAvailableAuthForProvider } = await loadModelAuth();
  return await hasAvailableAuthForProvider({
    ...params,
    modelApi: resolveOpenAiAudioAuthModelApi({
      capability: params.capability,
      providerId: params.provider,
    }),
  });
}

export type MediaExecutionContext = {
  signal: AbortSignal;
  assertCurrent: () => void;
};

export function assertMediaExecutionCurrent(execution?: MediaExecutionContext): void {
  execution?.signal.throwIfAborted();
  execution?.assertCurrent();
}

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
  execution?: MediaExecutionContext,
): Promise<T> {
  const invoke = (requestAuth: Pick<AudioTranscriptionRequest, "apiKey" | "auth">) => {
    assertMediaExecutionCurrent(execution);
    return execute(requestAuth);
  };
  const retry = resolveTransientProviderRetryOptions(providerOperationRetryConfig("read"));
  return auth.kind === "api-key"
    ? executeWithApiKeyRotation({
        provider,
        apiKeys: auth.apiKeys,
        transientRetry: retry && { ...retry, signal: execution?.signal },
        execute: (apiKey) =>
          invoke({
            apiKey,
            auth: { kind: "api-key", apiKey, source: auth.source },
          }),
      })
    : invoke({
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        auth: { kind: "none", source: auth.source ?? `provider:${provider}` },
      });
}

/** Availability uses the same hooks, secrets, and credential owner as execution. */
export async function isAudioModelEntryAvailable(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  entry: MediaUnderstandingModelConfig;
  secretOwnerId?: string;
  providerRegistry: ProviderRegistry;
}): Promise<boolean> {
  const { entry } = params;
  if ((entry.type ?? (entry.command ? "cli" : "provider")) === "cli") {
    const cli = resolveCliModelEntry(entry);
    return cli.ok && Boolean(resolveExecutablePath(cli.value.command));
  }
  const providerId = normalizeMediaProviderId(entry.provider ?? "");
  const provider = getMediaUnderstandingProvider(providerId, params.providerRegistry);
  if (!provider?.transcribeAudio && !provider?.transcribeAudioWithContext) {
    return false;
  }
  try {
    assertRuntimeMediaRequestSecretOwnerAvailable({ capability: "audio", entry });
    if (params.secretOwnerId) {
      assertSecretOwnerAvailable("capability", params.secretOwnerId);
    }
    if (provider.isAudioConfigured) {
      return await provider.isAudioConfigured({
        cfg: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        profile: entry.profile,
        preferredProfile: entry.preferredProfile,
        model: entry.model,
        ...resolveProviderRequestContext({
          ...params,
          providerId,
          config: params.cfg.tools?.media?.audio,
        }),
      });
    }
    if (!provider.transcribeAudioWithContext) {
      await resolveProviderExecutionAuth({ ...params, capability: "audio", providerId, provider });
    }
    return true;
  } catch {
    return false;
  }
}

export async function resolveProviderExecutionAuth(params: {
  capability: MediaUnderstandingCapability;
  cfg: OpenClawConfig;
  entry: MediaUnderstandingModelConfig;
  agentDir?: string;
  workspaceDir?: string;
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
    return apiKeyAuth(requireApiKey(auth, params.providerId), auth.source);
  } catch (err) {
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
