import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import pMap from "p-map";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  type AuthProfileCredential as ProfileEntry,
  type AuthProfileEligibilityReasonCode,
  externalCliDiscoveryScoped,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileEligibility,
  upsertAuthProfileWithLock,
} from "../../agents/auth-profiles.js";
import { resolveAuthProfileOrderWithMetadata } from "../../agents/auth-profiles/order.js";
import { getScopedAuthProfileEnv } from "../../agents/auth-profiles/store.js";
import { describeFailoverError } from "../../agents/failover-error.js";
import { FAILOVER_PROBE_STATUS as PROBE_STATUS_BY_FAILOVER_REASON } from "../../agents/failover/probe-status.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import { isNonSecretApiKeyMarker } from "../../agents/model-auth-markers.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
  resolveEnvApiKey,
  resolveProviderEntryApiKeyBinding,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../../agents/model-selection.js";
import { readPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveMergedModelProviderEntry } from "../../config/model-provider-config.js";
import {
  copyConfigResolutionFacts,
  copyConfigResolutionFactsExcept,
  resolveConfigSecretRef,
} from "../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
  resolveSecretInputRef,
} from "../../config/types.secrets.js";
import type {
  EmbeddedStateLockHandle,
  EmbeddedStateSignalProcess,
} from "../../infra/embedded-state-lock.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "../../infra/gateway-lock.js";
import { type SecretRefResolveCache, resolveSecretRefString } from "../../secrets/resolve.js";
import { appendConfigPathSegment } from "../../shared/dot-path.js";
import { redactStatusSecrets as redactAuthProbeError } from "../status-all/format.js";
import { createAuthProbeWork, disposeAuthProbeDirectory } from "./list.probe.cleanup.js";
import { buildProbeCandidateMap, selectProbeModel } from "./list.probe.models.js";
import { formatMs } from "./shared.js";

const PROBE_PROMPT = "Reply with OK. Do not use tools.";

export { redactAuthProbeError };

export type AuthProbeStatus =
  | "ok"
  | "auth"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "format"
  | "unknown"
  | "no_model";

/** Reason code for probes that never reached a model call. */
export type AuthProbeReasonCode =
  | "excluded_by_auth_order"
  | "missing_credential"
  | "expired"
  | "invalid_expires"
  | "unresolved_ref"
  | "ineligible_profile"
  | "no_model";

export type AuthProbeResult = {
  provider: string;
  model?: string;
  profileId?: string;
  label: string;
  source: "profile" | "env" | "models.json";
  mode?: string;
  status: AuthProbeStatus;
  reasonCode?: AuthProbeReasonCode;
  error?: string;
  latencyMs?: number;
};

type AuthProbeTarget = Pick<
  AuthProbeResult,
  "provider" | "profileId" | "label" | "source" | "mode"
> & {
  model?: { provider: string; model: string } | null;
  boundValue?: string;
  useRuntimeAuth?: boolean;
};

function buildProbeResult(
  target: AuthProbeTarget,
  outcome: Pick<AuthProbeResult, "status" | "reasonCode" | "error" | "latencyMs">,
): AuthProbeResult {
  return {
    provider: target.provider,
    model: target.model ? `${target.model.provider}/${target.model.model}` : undefined,
    profileId: target.profileId,
    label: target.label,
    source: target.source,
    mode: target.mode,
    ...outcome,
  };
}

function buildNoModelProbeResult(target: AuthProbeTarget): AuthProbeResult {
  return buildProbeResult(target, {
    status: "no_model",
    reasonCode: "no_model",
    error: "No model available for check",
  });
}

export type AuthProbeSummary = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalTargets: number;
  options: Omit<AuthProbeOptions, "includeDirectKeys">;
  results: AuthProbeResult[];
};

export type AuthProbeOptions = {
  provider?: string;
  profileIds?: string[];
  includeDirectKeys?: boolean;
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
};

export function mapFailoverReasonToProbeStatus(reason?: string | null): AuthProbeStatus {
  return reason
    ? (PROBE_STATUS_BY_FAILOVER_REASON[reason as FailoverReason] ?? "unknown")
    : "unknown";
}

const ELIGIBILITY_PROBE_ERRORS = {
  expired: "token credentials are expired.",
  invalid_expires: "token expires must be a positive Unix ms timestamp.",
  missing_credential: "no inline credential or SecretRef is configured.",
  unresolved_ref: "configured SecretRef could not be resolved.",
  ineligible_profile: "profile is incompatible with provider config.",
};

function mapEligibilityReasonToProbeReasonCode(
  reasonCode: AuthProfileEligibilityReasonCode,
): keyof typeof ELIGIBILITY_PROBE_ERRORS {
  switch (reasonCode) {
    case "missing_credential":
    case "expired":
    case "invalid_expires":
    case "unresolved_ref":
      return reasonCode;
    default:
      return "ineligible_profile";
  }
}

function resolveProbeSecretRef(profile: ProfileEntry, cfg: OpenClawConfig) {
  const defaults = cfg.secrets?.defaults;
  if (profile.type === "api_key") {
    return resolveSecretInputRef({ value: profile.key, refValue: profile.keyRef, defaults }).ref;
  }
  if (profile.type === "token") {
    return resolveSecretInputRef({ value: profile.token, refValue: profile.tokenRef, defaults })
      .ref;
  }
  return null;
}

function formatUnresolvedRefProbeError(refLabel: string): string {
  const legacyLine = "Auth profile credentials are missing or expired.";
  return `${legacyLine}\n↳ Auth reason [unresolved_ref]: could not resolve SecretRef "${refLabel}".`;
}

function createProbeConfig(cfg: OpenClawConfig, target: AuthProbeTarget): OpenClawConfig {
  if (!target.useRuntimeAuth && !target.boundValue) {
    return cfg;
  }
  const value = target.useRuntimeAuth ? undefined : target.boundValue;
  const entry = value ? resolveMergedModelProviderEntry(cfg, target.provider) : undefined;
  const next: OpenClawConfig = {
    ...cfg,
    ...(entry?.providerConfig
      ? {
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              [entry.providerKey]: {
                ...entry.providerConfig,
                apiKey: value,
                auth: target.mode === "oauth" || target.mode === "token" ? target.mode : "api-key",
              },
            },
          },
        }
      : {}),
    auth: {
      ...cfg.auth,
      order: {
        ...cfg.auth?.order,
        [target.provider]: [],
      },
    },
  };
  if (entry?.providerConfig) {
    copyConfigResolutionFactsExcept(cfg, next, [
      `${appendConfigPathSegment("models.providers", entry.providerKey)}.apiKey`,
    ]);
  } else {
    copyConfigResolutionFacts(cfg, next);
  }
  return next;
}

async function resolveConfiguredProbeCredential(params: {
  cfg: OpenClawConfig;
  input: unknown;
  path: string;
  cache: SecretRefResolveCache;
}): Promise<string | null> {
  const ref = resolveConfigSecretRef({
    config: params.cfg,
    path: params.path,
    value: params.input,
    defaults: params.cfg.secrets?.defaults,
  });
  if (!ref) {
    return normalizeSecretInputString(params.input) ?? null;
  }
  try {
    return await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
  } catch {
    return null;
  }
}

async function maybeResolveUnresolvedRefIssue(params: {
  cfg: OpenClawConfig;
  profile?: ProfileEntry;
  cache: SecretRefResolveCache;
}): Promise<{ reasonCode: "unresolved_ref"; error: string } | null> {
  if (!params.profile) {
    return null;
  }
  const ref = resolveProbeSecretRef(params.profile, params.cfg);
  if (!ref) {
    return null;
  }
  try {
    await resolveSecretRefString(ref, {
      config: params.cfg,
      env: process.env,
      cache: params.cache,
    });
    return null;
  } catch {
    return {
      reasonCode: "unresolved_ref",
      error: formatUnresolvedRefProbeError(`${ref.source}:${ref.provider}:${ref.id}`),
    };
  }
}

export async function buildProbeTargets(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers: string[];
  modelCandidates: string[];
  options: AuthProbeOptions;
}): Promise<{ targets: AuthProbeTarget[]; results: AuthProbeResult[] }> {
  const { cfg, agentDir, providers, modelCandidates, options, workspaceDir } = params;
  const authAliasLookupParams = { config: cfg, workspaceDir };
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryScoped({
      config: cfg,
      allowKeychainPrompt: false,
      providerIds: providers.map((provider) =>
        resolveProviderIdForAuth(provider, authAliasLookupParams),
      ),
      profileIds: options.profileIds,
    }),
  });
  const providerFilter = options.provider?.trim();
  const providerFilterKey = providerFilter ? normalizeProviderId(providerFilter) : null;
  const profileFilter = new Set(normalizeUniqueStringEntries(options.profileIds));
  const refResolveCache: SecretRefResolveCache = {};
  const candidates = buildProbeCandidateMap(modelCandidates);
  const providersNeedingCatalog = providers.filter(
    (provider) => !candidates.has(normalizeProviderId(provider)),
  );
  const catalog = providersNeedingCatalog.length
    ? await readPreparedModelCatalog({
        config: cfg,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(agentDir ? { agentDir } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
        readOnly: true,
        providerDiscoveryProviderIds: providersNeedingCatalog,
      })
    : [];
  const targets: AuthProbeTarget[] = [];
  const results: AuthProbeResult[] = [];
  const appendTarget = (target: AuthProbeTarget) => {
    if (target.model) {
      targets.push(target);
    } else {
      results.push(buildNoModelProbeResult(target));
    }
  };

  for (const provider of providers) {
    const providerKey = normalizeProviderId(provider);
    const authProviderKey = resolveProviderIdForAuth(providerKey, authAliasLookupParams);
    if (providerFilterKey && providerKey !== providerFilterKey) {
      continue;
    }

    const model = selectProbeModel({
      provider: providerKey,
      candidates,
      catalog,
    });
    const configuredProviderEntry = resolveMergedModelProviderEntry(cfg, providerKey);
    const configuredProvider = configuredProviderEntry?.providerConfig;
    const hasConfiguredProviderSecretRef = Boolean(
      configuredProviderEntry &&
      resolveConfigSecretRef({
        config: cfg,
        path: `${appendConfigPathSegment("models.providers", configuredProviderEntry.providerKey)}.apiKey`,
        value: configuredProvider?.apiKey,
        defaults: cfg.secrets?.defaults,
      }),
    );
    const includeDirectKeys = options.includeDirectKeys === true && profileFilter.size === 0;
    const includeConfigKey =
      includeDirectKeys &&
      hasConfiguredSecretInput(configuredProvider?.apiKey, cfg.secrets?.defaults);
    // Keep profiles saved under either surface. The production profile helper
    // is alias-aware, but scoped plugin metadata can differ between lookups.
    const profileIds = [
      ...new Set([
        ...listProfilesForProvider(store, authProviderKey),
        ...(authProviderKey === providerKey ? [] : listProfilesForProvider(store, providerKey)),
      ]),
    ];
    const configuredReference = includeConfigKey
      ? resolveProviderEntryApiKeyProfileReference({
          cfg,
          provider: providerKey,
          store,
        })
      : ({ kind: "none" } as const);
    const configuredBinding =
      configuredReference.kind === "profile" && !profileIds.includes(configuredReference.profileId)
        ? await resolveProviderEntryApiKeyBinding({
            cfg,
            provider: providerKey,
            store,
            agentDir,
          })
        : null;
    const configuredValue =
      configuredProviderEntry &&
      includeConfigKey &&
      configuredReference.kind !== "profile" &&
      configuredReference.kind !== "profile-incompatible"
        ? configuredReference.kind === "marker"
          ? (resolveUsableCustomProviderApiKey({
              cfg,
              provider: providerKey,
              env: process.env,
            })?.apiKey ?? null)
          : await resolveConfiguredProbeCredential({
              cfg,
              input: configuredProvider?.apiKey,
              path: `${appendConfigPathSegment("models.providers", configuredProviderEntry.providerKey)}.apiKey`,
              cache: refResolveCache,
            })
        : null;
    const configuredMode =
      configuredProvider?.auth === "oauth" || configuredProvider?.auth === "token"
        ? configuredProvider.auth
        : "api_key";
    const resolvedEnvironmentValue =
      includeDirectKeys && !hasConfiguredProviderSecretRef
        ? resolveEnvApiKey(authProviderKey, process.env, {
            config: cfg,
            workspaceDir,
          })
        : null;
    const environmentValue =
      resolvedEnvironmentValue?.apiKey === configuredValue ? null : resolvedEnvironmentValue;
    const configuredTargetLabel =
      configuredReference.kind === "marker" &&
      configuredValue &&
      isNonSecretApiKeyMarker(configuredValue, { includeEnvVarName: false })
        ? "provider"
        : "config";

    const explicitOrder =
      findNormalizedProviderValue(store.order, authProviderKey) ??
      findNormalizedProviderValue(store.order, providerKey) ??
      findNormalizedProviderValue(cfg?.auth?.order, authProviderKey) ??
      findNormalizedProviderValue(cfg?.auth?.order, providerKey);
    const orderResolution = resolveAuthProfileOrderWithMetadata({
      cfg,
      store,
      provider: providerKey,
      forModel: model?.model,
    });
    const allowedProfiles = orderResolution.hasExplicitOrder
      ? new Set(orderResolution.profileIds)
      : null;
    // Explicit auth.order both selects and documents profile eligibility; report
    // excluded profiles instead of silently skipping them.
    const filteredProfiles = profileFilter.size
      ? profileIds.filter((id) => profileFilter.has(id))
      : profileIds;

    for (const profileId of filteredProfiles) {
      const profile = store.profiles[profileId];
      const mode = profile?.type;
      const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
      const target: AuthProbeTarget = {
        provider: providerKey,
        model,
        profileId,
        label,
        source: "profile",
        mode,
      };
      // A profile referenced by models.providers.<id>.apiKey is resolved by
      // runtime binding ahead of auth.order fallback, so it stays effective
      // even when excluded from auth.order. Probe it instead of reporting it
      // as excluded, matching runtime credential precedence.
      const isConfigBoundProfile =
        includeConfigKey &&
        configuredReference.kind === "profile" &&
        profileId === configuredReference.profileId;
      let issue: { reasonCode: AuthProbeReasonCode; error: string } | null;
      if (!isConfigBoundProfile && explicitOrder && !explicitOrder.includes(profileId)) {
        issue = {
          reasonCode: "excluded_by_auth_order",
          error: "Excluded by auth.order for this provider.",
        };
      } else if (!isConfigBoundProfile && allowedProfiles && !allowedProfiles.has(profileId)) {
        const eligibility = resolveAuthProfileEligibility({
          cfg,
          store,
          provider: providerKey,
          profileId,
        });
        const reasonCode = mapEligibilityReasonToProbeReasonCode(eligibility.reasonCode);
        issue = {
          reasonCode,
          error: `Auth profile credentials are missing or expired.\n↳ Auth reason [${reasonCode}]: ${ELIGIBILITY_PROBE_ERRORS[reasonCode]}`,
        };
      } else {
        issue = await maybeResolveUnresolvedRefIssue({ cfg, profile, cache: refResolveCache });
      }
      if (issue) {
        results.push(buildProbeResult(target, { status: "unknown", ...issue }));
      } else {
        appendTarget(target);
      }
    }

    if (filteredProfiles.length === 0 && profileFilter.size > 0) {
      continue;
    }
    if (includeConfigKey) {
      const target = {
        provider: providerKey,
        model,
        ...(configuredReference.kind === "profile" ||
        configuredReference.kind === "profile-incompatible"
          ? { profileId: configuredReference.profileId }
          : {}),
        label: "config",
        source: "models.json" as const,
        mode: configuredMode,
      };
      const unresolvedResult = (error: string): AuthProbeResult => ({
        ...target,
        model: model ? `${model.provider}/${model.model}` : undefined,
        status: model ? "unknown" : "no_model",
        reasonCode: model ? "unresolved_ref" : "no_model",
        error: model ? error : "No model available for check",
      });
      if (configuredReference.kind === "profile-incompatible") {
        results.push({
          ...target,
          model: model ? `${model.provider}/${model.model}` : undefined,
          status: "unknown",
          reasonCode: "ineligible_profile",
          error: "Configured API key references an incompatible auth profile.",
        });
      } else if (configuredReference.kind === "profile") {
        if (!profileIds.includes(configuredReference.profileId)) {
          if (configuredBinding?.kind === "profile-resolved" && model) {
            targets.push({
              ...target,
              profileId: configuredBinding.auth.profileId,
              mode: configuredBinding.auth.mode,
              boundValue: configuredBinding.auth.apiKey,
            });
          } else {
            results.push(unresolvedResult("Configured auth profile could not be resolved."));
          }
        }
      } else if (!configuredValue) {
        results.push(unresolvedResult("Configured API key could not be resolved."));
      } else {
        appendTarget({
          ...target,
          label: configuredTargetLabel,
          boundValue: configuredValue,
          ...(configuredReference.kind === "marker" ? { useRuntimeAuth: true } : {}),
        });
      }
    }
    if (environmentValue) {
      // Honor an explicit provider auth override (token/oauth) the way normal
      // dispatch does; only fall back to the env-name heuristic when the
      // provider does not pin a mode, so a token-auth provider fed by a
      // *_API_KEY var is not misprobed as api-key and falsely failed.
      const mode =
        configuredProvider?.auth === "oauth" || configuredProvider?.auth === "token"
          ? configuredProvider.auth
          : environmentValue.source.includes("OAUTH_TOKEN")
            ? "oauth"
            : "api_key";
      appendTarget({
        provider: providerKey,
        model,
        label: environmentValue.source,
        source: "env",
        mode,
        boundValue: environmentValue.apiKey,
      });
    }
    if (filteredProfiles.length > 0 || includeConfigKey || environmentValue) {
      continue;
    }
    const hasUsableModelsJsonKey = hasUsableCustomProviderApiKey(cfg, providerKey);
    const hasSyntheticLocalAuth = hasSyntheticLocalProviderAuthConfig({
      cfg,
      provider: providerKey,
    });
    if (orderResolution.hasExplicitOrder && !hasUsableModelsJsonKey && !hasSyntheticLocalAuth) {
      continue;
    }

    const envKey =
      orderResolution.hasExplicitOrder || hasConfiguredProviderSecretRef
        ? null
        : resolveEnvApiKey(authProviderKey, process.env, {
            config: cfg,
            workspaceDir,
          });
    if (!envKey && !hasUsableModelsJsonKey && !hasSyntheticLocalAuth) {
      continue;
    }

    const source = envKey ? "env" : "models.json";
    const mode = envKey?.source.includes("OAUTH_TOKEN") ? "oauth" : "api_key";

    appendTarget({
      provider: providerKey,
      model,
      label: source,
      source,
      mode,
      ...(hasSyntheticLocalAuth && !envKey && !hasUsableModelsJsonKey
        ? { useRuntimeAuth: true }
        : {}),
    });
  }

  return { targets, results };
}

async function probeTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  target: AuthProbeTarget;
  timeoutMs: number;
  maxTokens: number;
  abortSignal?: AbortSignal;
}): Promise<AuthProbeResult> {
  const { cfg, agentId, agentDir, workspaceDir, target, timeoutMs, maxTokens } = params;
  // Marker credentials must be resolved by the runtime from config, but the
  // "config" probe must reflect only that credential — empty the provider auth
  // order and isolate the agent dir so stored profiles cannot satisfy it via
  // failover. Direct bound values instead pin an isolated synthetic profile.
  const probeConfig = createProbeConfig(cfg, target);
  if (!target.model) {
    return buildNoModelProbeResult(target);
  }
  const model = target.model;

  let isolatedAgentDir: string | null = null;
  let isolatedAuthEnv: NodeJS.ProcessEnv | undefined;
  let isolatedProfileId: string | undefined;
  let latencyMs: number | undefined;

  const work = await createAuthProbeWork(params.abortSignal);
  const buildResult = (status: AuthProbeResult["status"], error?: string): AuthProbeResult =>
    buildProbeResult(target, {
      status,
      ...(error ? { error } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    });
  try {
    // A bound credential must not fall back to another stored profile.
    if (target.boundValue || target.useRuntimeAuth) {
      // Keep native, worker, and registry locators canonical across macOS's
      // os.tmpdir() symlink (/var -> /private/var).
      isolatedAgentDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-probe-")),
      );
      isolatedAuthEnv = cloneEnvWithPlatformSemantics(getScopedAuthProfileEnv() ?? process.env);
    }
    if (target.boundValue && !target.useRuntimeAuth && isolatedAgentDir) {
      isolatedProfileId = `${target.provider}:probe-${crypto.randomUUID()}`;
      const value = target.boundValue;
      const profile: ProfileEntry =
        target.mode === "oauth"
          ? {
              type: "oauth",
              provider: target.provider,
              access: value,
              refresh: "not-a-real",
              expires: Date.now() + 60 * 60 * 1000,
            }
          : target.mode === "token"
            ? { type: "token", provider: target.provider, token: value }
            : { type: "api_key", provider: target.provider, key: value };
      const updated = await upsertAuthProfileWithLock({
        profileId: isolatedProfileId,
        credential: profile,
        agentDir: isolatedAgentDir,
      });
      if (!updated) {
        throw new Error("Could not prepare isolated auth check profile");
      }
    }
    // Keep normal status reads from loading the inference runtime; only --probe needs it.
    const { runIsolatedCompletion } = await import("../../agents/isolated-completion.js");
    const result = await work.run(() =>
      runIsolatedCompletion({
        config: probeConfig,
        agentId,
        agentDir: isolatedAgentDir ?? agentDir,
        workspaceDir,
        provider: model.provider,
        model: model.model,
        authProfileId: isolatedProfileId ?? target.profileId,
        ...(isolatedAgentDir ? { preparedModelRuntimeMode: "isolated-read-only" as const } : {}),
        // OAuth/native profiles retain the raw transport and persistent refresh owner.
        ...(target.source !== "profile" || target.mode !== "api_key"
          ? { agentHarnessRuntimeOverride: "openclaw" }
          : {}),
        systemPrompt: "",
        prompt: PROBE_PROMPT,
        timeoutMs,
        abortSignal: params.abortSignal,
        streamParams: { maxTokens },
        outputTextPolicy: "strict-visible",
        onRequestComplete: (durationMs) => {
          latencyMs = Math.round(durationMs);
        },
      }),
    );
    if (!result.text.trim()) {
      return buildResult("format", "The provider returned no visible text.");
    }
    return buildResult("ok");
  } catch (err) {
    const described = describeFailoverError(err);
    return buildResult(
      mapFailoverReasonToProbeStatus(described.reason),
      redactAuthProbeError(described.message),
    );
  } finally {
    await work.settle(async () => {
      if (isolatedAgentDir) {
        await disposeAuthProbeDirectory(isolatedAgentDir, isolatedAuthEnv);
      }
    });
  }
}

async function runTargetsWithConcurrency(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  targets: AuthProbeTarget[];
  options: AuthProbeOptions;
  onProgress?: (update: { completed: number; total: number; label?: string }) => void;
  abortSignal?: AbortSignal;
}): Promise<AuthProbeResult[]> {
  const { cfg, targets, options, onProgress } = params;
  const { timeoutMs, maxTokens } = options;
  const concurrency = Math.max(1, Math.min(targets.length || 1, options.concurrency));

  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const agentDir = params.agentDir ?? resolveAgentDir(cfg, agentId);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);

  await fs.mkdir(workspaceDir, { recursive: true });

  let completed = 0;
  return await pMap(
    targets,
    async (target) => {
      onProgress?.({
        completed,
        total: targets.length,
        label: `Checking ${target.provider}${target.profileId ? ` (${target.label})` : ""}`,
      });
      const result = await probeTarget({
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        target,
        timeoutMs,
        maxTokens,
        abortSignal: params.abortSignal,
      });
      completed += 1;
      onProgress?.({ completed, total: targets.length });
      return result;
    },
    {
      concurrency,
      stopOnError: true,
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
    },
  );
}

function formatActiveGatewayModelsProbeRefusal(identity: GatewayLockIdentity): string {
  return `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Stop the Gateway first (${formatCliCommand("openclaw gateway stop")}), then rerun models status --probe.`;
}

type AuthProbeStateOwnership = {
  mode: "exclusive";
  gatewayLockOptions?: GatewayLockOptions;
  process?: EmbeddedStateSignalProcess;
};

/** Own canonical state only for direct CLI probes; Gateway RPC probes already run under its lock. */
export async function withAuthProbeStateOwnership<T>(
  ownership: AuthProbeStateOwnership | undefined,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!ownership) {
    return await run();
  }
  const { acquireEmbeddedStateLock, createEmbeddedStateSignalBridge } =
    await import("../../infra/embedded-state-lock.js");
  const signalBridge = createEmbeddedStateSignalBridge(ownership.process ?? process);
  let stateLock: EmbeddedStateLockHandle | null | undefined;
  let work: Awaited<ReturnType<typeof createAuthProbeWork>> | undefined;
  try {
    work = await createAuthProbeWork(signalBridge.signal);
    stateLock = await acquireEmbeddedStateLock({
      options: ownership.gatewayLockOptions,
      signal: signalBridge.signal,
      formatActiveGatewayRefusal: formatActiveGatewayModelsProbeRefusal,
    });
    return await work.run(() => run(signalBridge.signal));
  } finally {
    const release = async () => {
      try {
        await stateLock?.release();
      } finally {
        signalBridge.dispose();
      }
    };
    if (work) {
      await work.settle(release);
    } else {
      await release();
    }
  }
}

export async function runAuthProbes(
  params: Parameters<typeof buildProbeTargets>[0] & {
    onProgress?: Parameters<typeof runTargetsWithConcurrency>[0]["onProgress"];
    stateOwnership?: AuthProbeStateOwnership;
  },
): Promise<AuthProbeSummary> {
  return await withAuthProbeStateOwnership(params.stateOwnership, async (abortSignal) => {
    const startedAt = Date.now();
    const plan = await buildProbeTargets(params);

    const totalTargets = plan.targets.length;
    params.onProgress?.({ completed: 0, total: totalTargets });

    const results = totalTargets
      ? await runTargetsWithConcurrency({
          ...params,
          targets: plan.targets,
          abortSignal,
        })
      : [];

    const finishedAt = Date.now();

    return {
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      totalTargets,
      options: params.options,
      results: [...plan.results, ...results],
    };
  });
}

export function sortProbeResults(results: AuthProbeResult[]): AuthProbeResult[] {
  return results.toSorted((a, b) => {
    const provider = a.provider.localeCompare(b.provider);
    if (provider !== 0) {
      return provider;
    }
    const aLabel = a.label || a.profileId || "";
    const bLabel = b.label || b.profileId || "";
    return aLabel.localeCompare(bLabel);
  });
}

export function describeProbeSummary(summary: AuthProbeSummary): string {
  if (summary.totalTargets === 0) {
    return "No check targets.";
  }
  return `Checked ${summary.totalTargets} target${summary.totalTargets === 1 ? "" : "s"} in ${formatMs(summary.durationMs)}`;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
