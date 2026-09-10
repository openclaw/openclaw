import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString as readTtsResultString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig, ResolvedTtsPersona, TtsProvider } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  acquirePluginCapabilityProviders,
  finishCapabilityOperation,
} from "../plugins/capability-provider-acquisition.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  createSpeechProviderRegistry,
  normalizeSpeechProviderId,
} from "./provider-registry-core.js";
import type { SpeechProviderConfig, SpeechProviderOverrides } from "./provider-types.js";
import {
  getResolvedSpeechProviderConfigForVoiceModel,
  mergeProviderConfigWithPersona,
  resolvePersonaProviderConfig,
  resolvePrimaryTtsProviderCandidate,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProvider,
  resolveTtsProviderCandidates,
  type TtsProviderRegistry,
} from "./tts-provider-resolution.js";
import type { TtsProviderAttempt } from "./tts-runtime-types.js";
import {
  readTtsPrefs,
  normalizeConfiguredSpeechProviderId,
  resolveTtsPersonaFromPrefs,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsRuntimeConfig,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import type { VoiceModelRef, VoiceProviderCandidate } from "./voice-models.js";

// The transport names its abort "TimeoutError" (fetch-timeout.ts) and provider
// deadlines throw plain Errors ending in "timed out"; AbortError alone misses both.
function isTtsTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.name === "AbortError" || err.name === "TimeoutError" || /\btimed out\b/iu.test(err.message)
  );
}

export function formatTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (isTtsTimeoutError(error)) {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${redactSensitiveText(error.message)}`;
}

export function sanitizeTtsErrorForLog(err: unknown): string {
  const raw = formatErrorMessage(err);
  return redactSensitiveText(raw).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/** Projection diagnostics remain primary when releasing an already-created synthesis also fails. */
export async function throwTtsProjectionError(
  error: unknown,
  cleanup: () => void | Promise<void>,
): Promise<never> {
  const [result] = await Promise.allSettled([Promise.resolve().then(cleanup)]);
  if (result.status === "rejected") {
    throw new AggregateError([error, result.reason], formatErrorMessage(error), { cause: error });
  }
  throw error;
}

function buildTtsFailureResult(
  errors: string[],
  attemptedProviders?: string[],
  attempts?: TtsProviderAttempt[],
  persona?: string,
): {
  success: false;
  error: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
  persona?: string;
} {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    attemptedProviders,
    attempts,
    persona,
  };
}

type TtsProviderReadyResolution =
  | {
      kind: "ready";
      provider: SpeechProviderPlugin;
      providerConfig: SpeechProviderConfig;
      personaProviderConfig?: SpeechProviderConfig;
      synthesisPersona?: ResolvedTtsPersona;
      personaBinding: "applied" | "missing" | "none";
    }
  | {
      kind: "skip";
      reasonCode: "no_provider_registered" | "not_configured" | "unsupported_for_telephony";
      message: string;
      personaBinding?: "missing";
    };

function resolveReadySpeechProvider(params: {
  provider: TtsProvider;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  voiceModel?: VoiceModelRef;
  requireTelephony?: boolean;
  providerRegistry: TtsProviderRegistry;
}): TtsProviderReadyResolution {
  const resolvedProvider = params.providerRegistry.getSpeechProvider(params.provider, params.cfg);
  if (!resolvedProvider) {
    return {
      kind: "skip",
      reasonCode: "no_provider_registered",
      message: `${params.provider}: no provider registered`,
    };
  }
  const providerConfig = getResolvedSpeechProviderConfigForVoiceModel({
    config: params.config,
    providerId: resolvedProvider.id,
    cfg: params.cfg,
    voiceModel: params.voiceModel,
    registry: params.providerRegistry,
  });
  const merged = mergeProviderConfigWithPersona({
    providerConfig,
    persona: params.persona,
    providerId: resolvedProvider.id,
  });
  if (params.persona?.fallbackPolicy === "fail" && merged.personaBinding === "missing") {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: persona ${params.persona.id} has no provider binding`,
      personaBinding: "missing",
    };
  }
  if (
    !resolvedProvider.isConfigured({
      cfg: params.cfg,
      providerConfig: merged.providerConfig,
      timeoutMs: resolveSpeechProviderTimeoutMs({
        config: params.config,
        provider: resolvedProvider,
      }),
    })
  ) {
    return {
      kind: "skip",
      reasonCode: "not_configured",
      message: `${params.provider}: not configured`,
    };
  }
  if (params.requireTelephony && !resolvedProvider.synthesizeTelephony) {
    return {
      kind: "skip",
      reasonCode: "unsupported_for_telephony",
      message: `${params.provider}: unsupported for telephony`,
    };
  }
  return {
    kind: "ready",
    provider: resolvedProvider,
    providerConfig: merged.providerConfig,
    personaProviderConfig: merged.personaProviderConfig,
    synthesisPersona:
      params.persona?.fallbackPolicy === "provider-defaults" && merged.personaBinding === "missing"
        ? undefined
        : params.persona,
    personaBinding: merged.personaBinding,
  };
}

async function prepareSpeechSynthesis(params: {
  provider: SpeechProviderPlugin;
  text: string;
  cfg: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
  persona?: ResolvedTtsPersona;
  personaProviderConfig?: SpeechProviderConfig;
  target: "audio-file" | "voice-note" | "telephony";
  timeoutMs: number;
}): Promise<{
  text: string;
  providerConfig: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
}> {
  if (!params.provider.prepareSynthesis) {
    return {
      text: params.text,
      providerConfig: params.providerConfig,
      providerOverrides: params.providerOverrides,
    };
  }
  const prepared = await params.provider.prepareSynthesis({
    text: params.text,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    providerOverrides: params.providerOverrides,
    persona: params.persona,
    personaProviderConfig: params.personaProviderConfig,
    target: params.target,
    timeoutMs: params.timeoutMs,
  });
  return {
    text: prepared?.text ?? params.text,
    providerConfig: prepared?.providerConfig
      ? { ...params.providerConfig, ...prepared.providerConfig }
      : params.providerConfig,
    providerOverrides: prepared?.providerOverrides
      ? { ...params.providerOverrides, ...prepared.providerOverrides }
      : params.providerOverrides,
  };
}

type TtsRequestSetupParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  providerOverride?: TtsProvider;
  disableFallback?: boolean;
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

function resolveTtsRequestConfig(
  params: TtsRequestSetupParams,
): { cfg: OpenClawConfig; config: ResolvedTtsConfig; prefsPath: string } | { error: string } {
  const cfg = resolveTtsRuntimeConfig(params.cfg);
  const config = resolveTtsConfig(cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? resolveTtsPrefsPath(config);
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }

  return { cfg, config, prefsPath };
}

type OwnedTtsRequestSetup =
  | { error: string }
  | {
      cfg: OpenClawConfig;
      config: ResolvedTtsConfig;
      persona?: ResolvedTtsPersona;
      providers: VoiceProviderCandidate[];
      prepareProviderRegistry: () => Promise<TtsProviderRegistry>;
    };

/** Keeps catalog and direct lookup selections in one explicit speech request owner. */
export async function acquireTtsRequest(params: TtsRequestSetupParams) {
  const facts = resolveTtsRequestConfig(params);
  if ("error" in facts) {
    return facts;
  }
  const { cfg, config, prefsPath } = facts;
  const prefs = readTtsPrefs(prefsPath);
  const persona = resolveTtsPersonaFromPrefs(config, prefs);
  const queries = await acquirePluginCapabilityProviders({ key: "speechProviders", cfg });
  try {
    const setup = await queries.run(async () => {
      const catalog = queries.providers;
      const defaultLookups = new Map<string, SpeechProviderPlugin | undefined>();
      let defaultCatalog: SpeechProviderPlugin[] = [];
      const preferred = normalizeSpeechProviderId(prefs.tts?.provider);
      if (preferred) {
        const provider = await queries.resolveProvider({ providerId: preferred });
        defaultLookups.set(preferred, provider);
        if (!provider) {
          defaultCatalog = await queries.resolveProviders({});
        }
      }
      const defaults = createSpeechProviderRegistry({
        getProvider: (providerId) => defaultLookups.get(providerId),
        listProviders: () => defaultCatalog,
      });
      const preferredProvider =
        defaults.canonicalizeSpeechProviderId(prefs.tts?.provider) ??
        normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
      const overrideProvider = normalizeSpeechProviderId(params.providerOverride);
      const requestedInputs = [
        overrideProvider,
        !overrideProvider ? preferredProvider : undefined,
        !preferredProvider ? persona?.provider : undefined,
        !overrideProvider && !preferredProvider ? config.provider : undefined,
        ...catalog.map((provider) => provider.id),
      ];
      const prepareView = async (
        queryConfig: OpenClawConfig,
        providers: SpeechProviderPlugin[],
      ) => {
        const lookups = new Map<string, SpeechProviderPlugin | undefined>();
        const requested = new Set(
          [...requestedInputs, ...providers.map((provider) => provider.id)].flatMap((id) => {
            const normalized = normalizeSpeechProviderId(id);
            return normalized ? [normalized] : [];
          }),
        );
        for (const providerId of requested) {
          const provider = await queries.resolveProvider({ providerId, cfg: queryConfig });
          lookups.set(providerId, provider);
          const canonical = normalizeSpeechProviderId(provider?.id);
          if (canonical) {
            requested.add(canonical);
          }
        }
        return createSpeechProviderRegistry({
          getProvider: (providerId) => lookups.get(providerId),
          listProviders: () => providers,
        });
      };
      const prepareProviderRegistry = async (): Promise<TtsProviderRegistry> => {
        const inputView = await prepareView(cfg, await queries.resolveProviders({ cfg }));
        const runtimeConfig = resolveTtsRuntimeConfig(cfg);
        const runtimeView =
          runtimeConfig === cfg
            ? inputView
            : await prepareView(
                runtimeConfig,
                await queries.resolveProviders({ cfg: runtimeConfig }),
              );
        // Policy helpers use the request config or the applicable config prepared for this phase.
        const selectRegistry = (queryConfig: OpenClawConfig | undefined) => {
          if (queryConfig === undefined) {
            return defaults;
          }
          return queryConfig === cfg ? inputView : runtimeView;
        };
        return {
          runtimeConfig,
          getSpeechProvider: (id, queryConfig) => selectRegistry(queryConfig).getSpeechProvider(id),
          canonicalizeSpeechProviderId: (id, queryConfig) =>
            selectRegistry(queryConfig).canonicalizeSpeechProviderId(id),
          listSpeechProviders: (queryConfig) => selectRegistry(queryConfig).listSpeechProviders(),
        };
      };
      const providerRegistry = await prepareProviderRegistry();
      const userProvider = resolveTtsProvider(config, prefsPath, providerRegistry, prefs);
      const provider =
        providerRegistry.canonicalizeSpeechProviderId(params.providerOverride, cfg) ?? userProvider;
      return {
        cfg,
        config,
        persona,
        providers: params.disableFallback
          ? [resolvePrimaryTtsProviderCandidate(provider, cfg, providerRegistry)]
          : resolveTtsProviderCandidates(provider, cfg, providerRegistry),
        prepareProviderRegistry,
      };
    });
    return { setup, run: queries.run, release: queries.release };
  } catch (error) {
    return await finishCapabilityOperation<never>({ ok: false, error }, queries.release);
  }
}

/** Finite speech calls finish their work before returning a materialized result. */
export async function withOwnedTtsRequest<T>(
  params: TtsRequestSetupParams,
  run: (setup: OwnedTtsRequestSetup) => T | Promise<T>,
): Promise<T> {
  const acquired = await acquireTtsRequest(params);
  if ("error" in acquired) {
    return await run(acquired);
  }
  let outcome: Result<T, unknown>;
  try {
    outcome = { ok: true, value: await acquired.run(() => run(acquired.setup)) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

type ReadySpeechProvider = Extract<TtsProviderReadyResolution, { kind: "ready" }>;
type PreparedSpeechSynthesis = Awaited<ReturnType<typeof prepareSpeechSynthesis>>;
type TtsProviderOperation<TSynthesis> =
  | {
      kind: "ready";
      synthesize: (params: {
        prepared: PreparedSpeechSynthesis;
        cfg: OpenClawConfig;
        target: "audio-file" | "voice-note" | "telephony";
        timeoutMs: number;
      }) => Promise<TSynthesis>;
      cleanupFailedProjection?: (synthesis: TSynthesis) => Promise<void>;
    }
  | {
      kind: "skip";
      reasonCode: TtsProviderAttempt["reasonCode"];
      message: string;
    };
type TtsProviderSuccess<TSynthesis> = {
  synthesis: TSynthesis;
  latencyMs: number;
  provider: string;
  providerModel?: string;
  providerVoice?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders: string[];
  attempts: TtsProviderAttempt[];
};

export async function executeTtsProviderAttempts<TSynthesis, TResult>(params: {
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  providers: VoiceProviderCandidate[];
  synthesisText: string;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
  timeoutMs?: number;
  target: "audio-file" | "voice-note" | "telephony";
  logLabel: string;
  requireTelephony?: boolean;
  prepareProviderRegistry: () => Promise<TtsProviderRegistry>;
  selectOperation: (params: {
    provider: TtsProvider;
    resolvedProvider: ReadySpeechProvider;
  }) => TtsProviderOperation<TSynthesis>;
  buildSuccess: (params: TtsProviderSuccess<TSynthesis>) => TResult;
}): Promise<TResult | ReturnType<typeof buildTtsFailureResult>> {
  const { cfg, config, persona, providers } = params;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  logVerbose(
    `${params.logLabel}: starting with provider ${primaryProvider}, fallbacks: ${
      providers
        .slice(1)
        .map((entry) => entry.provider)
        .join(", ") || "none"
    }`,
  );

  for (const { provider, voiceModel } of providers) {
    attemptedProviders.push(provider);
    const providerStart = Date.now();
    try {
      const providerRegistry = await params.prepareProviderRegistry();
      const resolvedProvider = resolveReadySpeechProvider({
        provider,
        cfg,
        config,
        persona,
        voiceModel,
        requireTelephony: params.requireTelephony,
        providerRegistry,
      });
      if (resolvedProvider.kind === "skip") {
        errors.push(resolvedProvider.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: resolvedProvider.reasonCode,
          persona: persona?.id,
          ...(resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {}),
          error: resolvedProvider.message,
        });
        logVerbose(
          `${params.logLabel}: provider ${provider} skipped (${resolvedProvider.message})`,
        );
        continue;
      }

      const operation = params.selectOperation({ provider, resolvedProvider });
      if (operation.kind === "skip") {
        errors.push(operation.message);
        attempts.push({
          provider,
          outcome: "skipped",
          reasonCode: operation.reasonCode,
          persona: persona?.id,
          personaBinding: resolvedProvider.personaBinding,
          error: operation.message,
        });
        logVerbose(`${params.logLabel}: provider ${provider} skipped (${operation.message})`);
        continue;
      }

      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const prepared = await prepareSpeechSynthesis({
        provider: resolvedProvider.provider,
        text: params.synthesisText,
        cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target: params.target,
        timeoutMs,
      });
      const synthesis = await operation.synthesize({
        prepared,
        cfg,
        target: params.target,
        timeoutMs,
      });
      try {
        const latencyMs = Date.now() - providerStart;
        attempts.push({
          provider,
          outcome: "success",
          reasonCode: "success",
          persona: persona?.id,
          personaBinding: resolvedProvider.personaBinding,
          latencyMs,
        });
        return params.buildSuccess({
          synthesis,
          latencyMs,
          provider,
          providerModel: resolveTtsResultModel(prepared.providerConfig, prepared.providerOverrides),
          providerVoice: resolveTtsResultVoice(prepared.providerConfig, prepared.providerOverrides),
          persona: persona?.id,
          fallbackFrom: provider !== primaryProvider ? primaryProvider : undefined,
          attemptedProviders,
          attempts,
        });
      } catch (error) {
        return await throwTtsProjectionError(error, () =>
          operation.cleanupFailedProjection?.(synthesis),
        );
      }
    } catch (err) {
      const errorMsg = formatTtsProviderError(provider, err);
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode: isTtsTimeoutError(err) ? "timeout" : "provider_error",
        latencyMs,
        persona: persona?.id,
        personaBinding: resolvePersonaBinding(persona, provider),
        error: errorMsg,
      });
      const rawError = sanitizeTtsErrorForLog(err);
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `${params.logLabel}: primary provider ${provider} failed (${rawError})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`${params.logLabel}: ${provider} failed (${rawError}); trying next provider.`);
      }
    }
  }

  return buildTtsFailureResult(errors, attemptedProviders, attempts, persona?.id);
}

function resolveTtsResultModel(
  providerConfig: SpeechProviderConfig,
  providerOverrides?: SpeechProviderOverrides,
): string | undefined {
  return (
    readTtsResultString(providerOverrides?.modelId) ??
    readTtsResultString(providerOverrides?.model) ??
    readTtsResultString(providerConfig.modelId) ??
    readTtsResultString(providerConfig.model)
  );
}

function resolveTtsResultVoice(
  providerConfig: SpeechProviderConfig,
  providerOverrides?: SpeechProviderOverrides,
): string | undefined {
  return (
    readTtsResultString(providerOverrides?.speakerVoiceId) ??
    readTtsResultString(providerOverrides?.speakerVoice) ??
    readTtsResultString(providerOverrides?.voiceId) ??
    readTtsResultString(providerOverrides?.voiceName) ??
    readTtsResultString(providerOverrides?.voice) ??
    readTtsResultString(providerConfig.speakerVoiceId) ??
    readTtsResultString(providerConfig.speakerVoice) ??
    readTtsResultString(providerConfig.voiceId) ??
    readTtsResultString(providerConfig.voiceName) ??
    readTtsResultString(providerConfig.voice)
  );
}

function resolvePersonaBinding(
  persona: ResolvedTtsPersona | undefined,
  provider: string,
): "applied" | "missing" | "none" {
  return resolvePersonaProviderConfig(persona, provider) != null
    ? "applied"
    : persona
      ? "missing"
      : "none";
}
