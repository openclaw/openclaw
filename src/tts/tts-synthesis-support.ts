import type { Result } from "@openclaw/normalization-core/result";
import { selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import type { OpenClawConfig, ResolvedTtsPersona, TtsProvider } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  acquirePluginCapabilityProviders,
  finishCapabilityOperation,
} from "../plugins/capability-provider-acquisition.js";
import { buildCapabilityProviderIndex } from "../plugins/provider-registry-shared.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  createSpeechProviderRegistry,
  normalizeSpeechProviderId,
} from "./provider-registry-core.js";
import type {
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechSynthesisTarget,
} from "./provider-types.js";
import {
  getResolvedSpeechProviderConfigForVoiceModel,
  mergeProviderConfigWithPersona,
  resolvePersonaProviderConfig,
  resolvePrimaryTtsProviderCandidate,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProviderAsync,
  resolveTtsProviderCandidates,
  type TtsProviderRegistry,
} from "./tts-provider-resolution.js";
import type { TtsProviderAttempt } from "./tts-runtime-types.js";
import {
  readTtsPrefs,
  resolveTtsPersonaFromPrefs,
  resolveTtsConfig,
  resolveTtsPrefsPathAsync,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import type { VoiceProviderCandidate } from "./voice-models.js";

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

type TtsRequestSetup = {
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  persona?: ResolvedTtsPersona;
  providers: VoiceProviderCandidate[];
  providerRegistry: TtsProviderRegistry;
};

type AcquiredTtsRequest =
  | { error: string }
  | ({ setup: TtsRequestSetup } & Pick<
      Awaited<ReturnType<typeof acquirePluginCapabilityProviders<"speechProviders">>>,
      "run" | "release"
    >);

/** Keeps catalog and direct lookup selections in one explicit speech request owner. */
export async function acquireTtsRequest(
  params: TtsRequestSetupParams,
): Promise<AcquiredTtsRequest> {
  const cfg = selectLiveRuntimeConfig(params.cfg);
  const config = resolveTtsConfig(cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = params.prefsPath ?? (await resolveTtsPrefsPathAsync(config));
  if (params.text.length > config.maxTextLength) {
    return {
      error: `Text too long (${params.text.length} chars, max ${config.maxTextLength})`,
    };
  }
  const prefs = readTtsPrefs(prefsPath);
  const persona = resolveTtsPersonaFromPrefs(config, prefs);
  const queries = await acquirePluginCapabilityProviders({ key: "speechProviders", cfg });
  try {
    const setup = await queries.run(async () => {
      const catalog = queries.providers;
      const preferred = normalizeSpeechProviderId(prefs.tts?.provider);
      let preferredProvider = preferred;
      if (preferred) {
        const provider = await queries.resolveProvider({ providerId: preferred });
        preferredProvider =
          provider?.id ??
          buildCapabilityProviderIndex(await queries.resolveProviders({}), "aliases").get(preferred)
            ?.id ??
          preferred;
      }
      const overrideProvider = normalizeSpeechProviderId(params.providerOverride);
      const requestedInputs = [
        overrideProvider,
        !overrideProvider ? preferredProvider : undefined,
        !preferredProvider ? persona?.provider : undefined,
        !overrideProvider && !preferredProvider ? config.provider : undefined,
        ...catalog.map((provider) => provider.id),
      ];
      const providers = await queries.resolveProviders({ cfg });
      const lookups = new Map<string, SpeechProviderPlugin | undefined>();
      const requested = new Set(
        [...requestedInputs, ...providers.map((provider) => provider.id)].flatMap((id) => {
          const normalized = normalizeSpeechProviderId(id);
          return normalized ? [normalized] : [];
        }),
      );
      for (const providerId of requested) {
        const provider = await queries.resolveProvider({ providerId, cfg });
        lookups.set(providerId, provider);
        const canonical = normalizeSpeechProviderId(provider?.id);
        if (canonical) {
          requested.add(canonical);
        }
      }
      // One request keeps its prepared selections; reloads apply to the next request.
      const providerRegistry: TtsProviderRegistry = {
        ...createSpeechProviderRegistry({
          getProvider: (providerId) => lookups.get(providerId),
          listProviders: () => providers,
        }),
        runtimeConfig: cfg,
      };
      const userProvider =
        preferredProvider ??
        (await resolveTtsProviderAsync(config, prefsPath, providerRegistry, prefs));
      const provider =
        providerRegistry.canonicalizeSpeechProviderId(params.providerOverride, cfg) ?? userProvider;
      return {
        cfg,
        config,
        persona,
        providers: params.disableFallback
          ? [resolvePrimaryTtsProviderCandidate(provider, cfg, providerRegistry)]
          : resolveTtsProviderCandidates(provider, cfg, providerRegistry),
        providerRegistry,
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
  run: (setup: TtsRequestSetup | { error: string }) => T | Promise<T>,
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
type TtsProviderOperation<TSynthesis> =
  | {
      kind: "ready";
      synthesize: (request: SpeechSynthesisRequest) => Promise<TSynthesis>;
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
  target: SpeechSynthesisTarget;
  logLabel: string;
  providerRegistry: TtsProviderRegistry;
  selectOperation: (params: {
    provider: TtsProvider;
    resolvedProvider: ReadySpeechProvider;
  }) => TtsProviderOperation<TSynthesis>;
  buildSuccess: (params: TtsProviderSuccess<TSynthesis>) => TResult;
}) {
  const { cfg, config, persona, providers } = params;
  const errors: string[] = [];
  const attemptedProviders: string[] = [];
  const attempts: TtsProviderAttempt[] = [];
  const primaryProvider = providers[0]?.provider;
  const recordSkipped = (
    provider: TtsProvider,
    skipped: Extract<TtsProviderOperation<TSynthesis>, { kind: "skip" }>,
    binding: Pick<TtsProviderAttempt, "personaBinding">,
  ) => {
    errors.push(skipped.message);
    attempts.push({
      provider,
      outcome: "skipped",
      reasonCode: skipped.reasonCode,
      persona: persona?.id,
      ...binding,
      error: skipped.message,
    });
    logVerbose(`${params.logLabel}: provider ${provider} skipped (${skipped.message})`);
  };
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
      const providerRegistry = params.providerRegistry;
      const target = params.target;
      const resolveReadyProvider = async (): Promise<TtsProviderReadyResolution> => {
        const candidateProvider = providerRegistry.getSpeechProvider(provider, cfg);
        if (!candidateProvider) {
          return {
            kind: "skip",
            reasonCode: "no_provider_registered",
            message: `${provider}: no provider registered`,
          };
        }
        const providerConfig = getResolvedSpeechProviderConfigForVoiceModel({
          config,
          providerId: candidateProvider.id,
          cfg,
          voiceModel,
          registry: providerRegistry,
        });
        const merged = mergeProviderConfigWithPersona({
          providerConfig,
          persona,
          providerId: candidateProvider.id,
        });
        if (persona?.fallbackPolicy === "fail" && merged.personaBinding === "missing") {
          return {
            kind: "skip",
            reasonCode: "not_configured",
            message: `${provider}: persona ${persona.id} has no provider binding`,
            personaBinding: "missing",
          };
        }
        const context = {
          cfg,
          providerConfig: merged.providerConfig,
          timeoutMs: resolveSpeechProviderTimeoutMs({ config, provider: candidateProvider }),
        };
        const configured = await (candidateProvider.isConfiguredAsync
          ? candidateProvider.isConfiguredAsync(context)
          : candidateProvider.isConfigured(context));
        if (!configured) {
          return {
            kind: "skip",
            reasonCode: "not_configured",
            message: `${provider}: not configured`,
          };
        }
        if (target === "telephony" && !candidateProvider.synthesizeTelephony) {
          return {
            kind: "skip",
            reasonCode: "unsupported_for_telephony",
            message: `${provider}: unsupported for telephony`,
          };
        }
        return {
          kind: "ready",
          provider: candidateProvider,
          providerConfig: merged.providerConfig,
          personaProviderConfig: merged.personaProviderConfig,
          synthesisPersona:
            persona?.fallbackPolicy === "provider-defaults" && merged.personaBinding === "missing"
              ? undefined
              : persona,
          personaBinding: merged.personaBinding,
        };
      };
      const resolvedProvider = await resolveReadyProvider();
      if (resolvedProvider.kind === "skip") {
        recordSkipped(
          provider,
          resolvedProvider,
          resolvedProvider.personaBinding
            ? { personaBinding: resolvedProvider.personaBinding }
            : {},
        );
        continue;
      }

      const operation = params.selectOperation({ provider, resolvedProvider });
      if (operation.kind === "skip") {
        recordSkipped(provider, operation, { personaBinding: resolvedProvider.personaBinding });
        continue;
      }

      const timeoutMs = resolveSpeechProviderTimeoutMs({
        timeoutMs: params.timeoutMs ?? voiceModel?.timeoutMs,
        config,
        provider: resolvedProvider.provider,
      });
      const request: SpeechProviderPrepareSynthesisContext = {
        text: params.synthesisText,
        cfg,
        providerConfig: resolvedProvider.providerConfig,
        providerOverrides: params.providerOverrides?.[resolvedProvider.provider.id],
        persona: resolvedProvider.synthesisPersona,
        personaProviderConfig: resolvedProvider.personaProviderConfig,
        target: params.target,
        timeoutMs,
      };
      const overrides = await resolvedProvider.provider.prepareSynthesis?.({ ...request });
      const prepared = {
        text: overrides?.text ?? request.text,
        providerConfig: overrides?.providerConfig
          ? { ...request.providerConfig, ...overrides.providerConfig }
          : request.providerConfig,
        providerOverrides: overrides?.providerOverrides
          ? { ...request.providerOverrides, ...overrides.providerOverrides }
          : request.providerOverrides,
      };
      const synthesis = await operation.synthesize({
        text: prepared.text,
        cfg,
        providerConfig: prepared.providerConfig,
        target: params.target,
        providerOverrides: prepared.providerOverrides,
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
          providerModel: resolveTtsResultDetail(prepared, ["modelId", "model"]),
          providerVoice: resolveTtsResultDetail(prepared, [
            "speakerVoiceId",
            "speakerVoice",
            "voiceId",
            "voiceName",
            "voice",
          ]),
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
      const reasonCode = isTtsTimeoutError(err) ? "timeout" : "provider_error";
      const latencyMs = Date.now() - providerStart;
      errors.push(errorMsg);
      attempts.push({
        provider,
        outcome: "failed",
        reasonCode,
        latencyMs,
        persona: persona?.id,
        personaBinding:
          resolvePersonaProviderConfig(persona, provider) != null
            ? "applied"
            : persona
              ? "missing"
              : "none",
        error: errorMsg,
      });
      if (provider === primaryProvider) {
        const hasFallbacks = providers.length > 1;
        logVerbose(
          `${params.logLabel}: primary provider ${provider} failed (${reasonCode})${hasFallbacks ? "; trying fallback providers." : "; no fallback providers configured."}`,
        );
      } else {
        logVerbose(`${params.logLabel}: ${provider} failed (${reasonCode}); trying next provider.`);
      }
    }
  }

  return {
    success: false as const,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
    attemptedProviders,
    attempts,
    persona: persona?.id,
  };
}

function resolveTtsResultDetail(
  prepared: Pick<SpeechSynthesisRequest, "providerConfig" | "providerOverrides">,
  keys: readonly string[],
): string | undefined {
  for (const config of [prepared.providerOverrides, prepared.providerConfig]) {
    const value = config ? readTrimmedStringAlias(config, keys) : undefined;
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
