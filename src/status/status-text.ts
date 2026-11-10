import os from "node:os";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import { resolveAgentHarnessAutoSelectionHint } from "../agents/harness/auto-selection.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { listRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { createModelCatalogView } from "../agents/model-catalog-view.js";
import {
  areRuntimeModelRefsEquivalent,
  shouldPreferActiveRuntimeAliasAuthLabel,
} from "../agents/model-runtime-aliases.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveConfiguredThinkingDefault } from "../agents/model-thinking-default.js";
import { resolveSandboxRuntimeStatusAsync } from "../agents/sandbox/runtime-status.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-helpers.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import { toAgentModelListLike } from "../config/model-input.js";
import { resolveFreshSessionTotalTokens } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionLifecycleTimestampsAsync } from "../config/sessions/lifecycle-read.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { resolveProjectedAgentRunProgressState } from "../infra/agent-run-registry.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { withTimeout } from "../infra/fs-safe.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../infra/provider-usage.js";
import { formatMissingCostEntries } from "../infra/session-cost-usage-totals.js";
import { loadSessionCostSummariesFromCache } from "../infra/session-cost-usage.js";
import { resolveActiveProviderThinkingProfile } from "../plugins/provider-thinking-active.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { prepareTtsPreferences } from "../tts/tts-preferences.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.read.js";
import { formatTokenCount, formatUsd } from "../utils/usage-format.js";
import {
  buildCodexSyntheticUsageAuth,
  resolveUsageCredentialType,
  shouldUseCodexSyntheticUsageForRuntime,
} from "./codex-synthetic-usage.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";
import { readSessionFallbackModelAsync } from "./session-fallback-model.js";
import type { StatusMessageParts } from "./status-message.js";
import { createStatusModelResolver } from "./status-model-auth.js";
import { formatCompactPluginHealthLine } from "./status-plugin-health.js";
import type { BuildStatusTextParams } from "./status-text.types.js";

function buildStatusUptimeValue(): string {
  const format = (ms: number) => formatDurationCompact(ms, { spaced: true }) ?? "0s";
  const gatewayMs = Math.max(0, Math.round(process.uptime() * 1000));
  const systemMs = Math.max(0, Math.round(os.uptime() * 1000));
  return `gateway ${format(gatewayMs)} · system ${format(systemMs)}`;
}

const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai",
]);

// Status loaders keep the lazy-promise eviction default: a transient module-load
// failure on one /status request self-heals on the next instead of poisoning
// every reply. Deliberately not createLazyRuntimeModule, whose sticky rejection
// cache would pin the failure for the process lifetime.
const loadStatusMessageRuntime = createLazyPromise(() =>
  import("./status-message.runtime.js").then((module) => module.loadStatusMessageRuntimeModule()),
);
const loadAgentThinkingRuntime = createLazyPromise(() => import("../agents/thinking-runtime.js"));
const loadThinkingLevelRuntime = createLazyPromise(() => import("../auto-reply/thinking.js"));
const loadStatusSubagentsRuntime = createLazyPromise(() => import("./status-subagents.runtime.js"));

const loadStatusQueueRuntime = createLazyPromise(() => import("./status-queue.runtime.js"));

const loadStatusPluginHealthRuntime = createLazyPromise(
  () => import("./status-plugin-health.runtime.js"),
);

async function resolveRuntimePluginHealthLine(): Promise<string | undefined> {
  try {
    const { collectRuntimePluginHealthSnapshot } = await loadStatusPluginHealthRuntime();
    return formatCompactPluginHealthLine(await collectRuntimePluginHealthSnapshot());
  } catch {
    return "⚠️ Plugins: health unavailable";
  }
}

export async function buildStatusText(params: BuildStatusTextParams): Promise<string> {
  return (await buildStatusReplyParts(params)).text;
}

// Status body plus its structured presentation mirror, for chat replies whose
// channel can render native tables; plain channels keep the text verbatim.
export async function buildStatusReplyParts(
  params: BuildStatusTextParams,
): Promise<StatusMessageParts> {
  const {
    cfg,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    statusChannel,
    provider,
    model,
    thinkingCatalog,
    resolvedThinkLevel,
    resolvedFastMode,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  const statusAgentId = resolveSessionAgentId({ sessionKey, config: cfg, agentId: params.agentId });
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const statusWorkspaceDir =
    params.workspaceDir ??
    sessionEntry?.spawnedWorkspaceDir ??
    resolveAgentWorkspaceDir(cfg, statusAgentId);
  const selectedProvider = sessionEntry?.providerOverride?.trim() ?? provider;
  const selectedModel = sessionEntry?.modelOverride?.trim() ?? model;
  const parseSelectedProvider = Boolean(
    sessionEntry?.modelOverride?.trim() && !sessionEntry?.providerOverride?.trim(),
  );
  const modelParams = { selectedProvider, selectedModel, sessionEntry, parseSelectedProvider };
  const activeModel =
    resolveProjectedAgentRunProgressState({
      agentId: statusAgentId,
      sessionId: sessionEntry?.sessionId,
      sessionKeys: sessionKey ? [sessionKey] : [],
    }) === undefined
      ? await readSessionFallbackModelAsync({
          ...modelParams,
          config: cfg,
          sessionScope: { agentId: statusAgentId, sessionKey, storePath },
        })
      : undefined;
  const modelRefs = resolveSelectedAndActiveModel({
    ...modelParams,
    sessionEntry: activeModel ?? sessionEntry,
  });
  const selectedLookupProvider = modelRefs.selected.provider || selectedProvider || provider;
  const selectedLookupModel = modelRefs.selected.model || selectedModel || model;
  const resolveStatusHarnessId = async (): Promise<string | undefined> => {
    try {
      const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
        provider: selectedLookupProvider,
        entry: sessionEntry,
        cfg,
      });
      const configuredRuntime = resolveAgentHarnessPolicy({
        provider: selectedLookupProvider,
        modelId: selectedLookupModel,
        config: cfg,
        agentId: statusAgentId,
        sessionKey,
      }).runtime;
      const runtime = sessionRuntime ?? configuredRuntime;
      if (runtime !== "auto") {
        return normalizeOptionalLowercaseString(runtime) || undefined;
      }
      const registeredHarnesses = listRegisteredAgentHarnesses();
      if (
        registeredHarnesses.every(
          ({ harness }) =>
            resolveAgentHarnessAutoSelectionHint({ harness, provider: selectedLookupProvider }) !==
            undefined,
        )
      ) {
        return "openclaw";
      }
      const { resolveEffectiveAgentRuntime } = await loadAgentThinkingRuntime();
      const id = resolveEffectiveAgentRuntime({
        cfg,
        provider: selectedLookupProvider,
        modelId: selectedLookupModel,
        agentId: statusAgentId,
        sessionKey,
        sessionEntry,
      });
      return normalizeOptionalLowercaseString(id) || undefined;
    } catch {
      // Harness selection is nice-to-have for display. Status should still render
      // if dynamic harness modules are unavailable.
      return undefined;
    }
  };
  const effectiveHarness = params.resolvedHarness ?? (await resolveStatusHarnessId());
  const { getPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("../agents/prepared-model-catalog.js");
  const preparedOwner = getPreparedModelCatalogOwnerSnapshot({
    config: cfg,
    agentId: statusAgentId,
    agentDir: statusAgentDir,
    workspaceDir: statusWorkspaceDir,
    readOnly: true,
  });
  const owner = preparedOwner ? materializePreparedModelCatalogOwner(preparedOwner) : undefined;
  // This lookup borrows existing facts; status never starts inventory discovery.
  const resolveModel = createStatusModelResolver({
    cfg,
    agentId: statusAgentId,
    agentDir: statusAgentDir,
    workspaceDir: statusWorkspaceDir,
    sessionEntry,
    owner,
  });
  const resolveStatusRuntimeProvider = (inputProvider: string): string => {
    const harness = normalizeOptionalLowercaseString(effectiveHarness);
    const normalizedProvider = normalizeOptionalLowercaseString(inputProvider);
    if (
      harness === "codex" &&
      (normalizedProvider === "openai" || normalizedProvider === "codex")
    ) {
      return "openai";
    }
    if (harness === "claude-cli" && normalizedProvider === "anthropic") {
      return "claude-cli";
    }
    return inputProvider;
  };
  const selectedStatusProvider = resolveStatusRuntimeProvider(selectedLookupProvider);
  const activeProvider = modelRefs.active.provider || provider;
  const activeStatusProvider = resolveStatusRuntimeProvider(activeProvider);
  const selectedResolution = await resolveModel({
    provider: selectedStatusProvider,
    model: selectedLookupModel,
    runtimeId: effectiveHarness,
    acceptedProviderIds: [selectedLookupProvider],
    ...(Object.hasOwn(params, "modelAuthOverride")
      ? { authLabelOverride: params.modelAuthOverride }
      : {}),
  });
  let selectedModelAuth = selectedResolution.authLabel;
  const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride")
    ? params.activeModelAuthOverride
    : modelRefs.activeDiffers
      ? (
          await resolveModel({
            provider: activeStatusProvider,
            model: modelRefs.active.model || model,
            runtimeId: effectiveHarness,
            acceptedProviderIds: [activeProvider],
          })
        ).authLabel
      : selectedModelAuth;
  const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(
    modelRefs.selected.label,
    modelRefs.active.label,
    { config: cfg },
  );
  const fallbackState = resolveActiveFallbackState({
    selectedModelRef: modelRefs.selected.label || "unknown",
    activeModelRef: modelRefs.active.label || "unknown",
    config: cfg,
    state: sessionEntry,
  });
  if (
    shouldPreferActiveRuntimeAliasAuthLabel({
      runtimeAliasModelEquivalent,
      selectedAuthLabel: selectedModelAuth,
      activeAuthLabel: activeModelAuth,
    })
  ) {
    // Runtime aliases can make selected/active model refs equivalent while auth
    // labels differ; prefer the active auth label so status matches execution.
    selectedModelAuth = activeModelAuth;
  }
  const activeRuntimeIsAuthoritative =
    !modelRefs.activeDiffers ||
    fallbackState.active ||
    hasSessionAutoModelFallbackProvenance(sessionEntry) ||
    runtimeAliasModelEquivalent;
  const usageAuthLabel = activeRuntimeIsAuthoritative ? activeModelAuth : selectedModelAuth;
  const usageStatusProvider = activeRuntimeIsAuthoritative
    ? activeStatusProvider
    : selectedStatusProvider;
  const usageProvider = activeRuntimeIsAuthoritative ? activeProvider : selectedLookupProvider;
  const selectedUsageCredentialType = resolveUsageCredentialType(usageAuthLabel);
  const useCodexSyntheticUsage =
    selectedUsageCredentialType !== "api_key" &&
    shouldUseCodexSyntheticUsageForRuntime({
      provider: usageStatusProvider,
      effectiveHarness,
      // A runtime fallback does not erase the session's Codex binding or its rate limits.
      sessionHarnessId: sessionEntry?.agentHarnessId,
    });
  const resolveCodexSyntheticUsageAuthProfileId = async (): Promise<string | undefined> => {
    const normalizedProfileId = sessionEntry?.authProfileOverride?.trim();
    if (!normalizedProfileId) {
      return undefined;
    }
    try {
      const store = await ensureAuthProfileStoreAsync(statusAgentDir, {
        allowKeychainPrompt: false,
        config: cfg,
        readOnly: true,
        syncExternalCli: false,
      });
      const credential = store.profiles[normalizedProfileId];
      if (!credential) {
        return undefined;
      }
      return normalizeOptionalLowercaseString(credential.provider) === "openai"
        ? normalizedProfileId
        : undefined;
    } catch {
      return undefined;
    }
  };
  const codexUsageAuthProfileId = useCodexSyntheticUsage
    ? await resolveCodexSyntheticUsageAuthProfileId()
    : undefined;
  const usageCredentialType = useCodexSyntheticUsage ? "token" : selectedUsageCredentialType;
  const currentUsageProvider =
    resolveUsageProviderId(usageStatusProvider, { credentialType: usageCredentialType }) ??
    resolveUsageProviderId(usageProvider, { credentialType: usageCredentialType });
  let usageLine: string | null = null;
  const normalizedUsageAuth = normalizeOptionalLowercaseString(usageAuthLabel);
  // OAuth-only endpoints cannot report usage for API-key sessions.
  if (
    currentUsageProvider &&
    (!USAGE_OAUTH_ONLY_PROVIDERS.has(currentUsageProvider) ||
      usageCredentialType === "oauth" ||
      usageCredentialType === "token" ||
      normalizedUsageAuth?.startsWith("oauth") ||
      normalizedUsageAuth?.startsWith("token"))
  ) {
    try {
      // Usage summary is optional operator context. Bound it tightly so a slow
      // provider usage probe cannot delay the status command.
      const usageSummaryTimeoutMs = useCodexSyntheticUsage ? 8000 : 3500;
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: usageSummaryTimeoutMs,
        providers: [currentUsageProvider],
        agentDir: statusAgentDir,
        workspaceDir: statusWorkspaceDir,
        config: cfg,
        auth: useCodexSyntheticUsage
          ? [buildCodexSyntheticUsageAuth({ authProfileId: codexUsageAuthProfileId })]
          : undefined,
      });
      const usageEntry = usageSummary.providers[0];
      if (
        usageEntry &&
        !usageEntry.error &&
        (usageEntry.windows.length > 0 ||
          Boolean(usageEntry.billing?.length) ||
          Boolean(usageEntry.summary?.trim()))
      ) {
        const summaryLine = formatUsageWindowSummary(usageEntry);
        if (summaryLine) {
          usageLine = `📊 Usage: ${summaryLine}`;
        }
      }
    } catch {
      usageLine = null;
    }
  }
  const costSessionId = sessionEntry?.sessionId?.trim();
  if (costSessionId) {
    try {
      const sessionFile = formatSqliteSessionFileMarker({
        sessionId: costSessionId,
        agentId: statusAgentId,
        storePath: await preparePhysicalSessionStorePath(
          { agentId: statusAgentId, ...(storePath ? { storePath } : {}) },
          cfg,
        ),
      });
      const now = Date.now();
      const date = new Date(now);
      const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const loaded = await withTimeout(
        loadSessionCostSummariesFromCache({
          sessions: [{ sessionId: costSessionId, sessionFile }],
          config: cfg,
          agentId: statusAgentId,
          startMs,
          endMs: now,
          dayBucket: { mode: "utc-offset", utcOffsetMinutes: -date.getTimezoneOffset() },
          requestRefresh: false,
        }),
        3_500,
        { message: "session cost timeout" },
      );
      const summary = loaded.cacheStatus.status === "fresh" ? loaded.summaries[0] : null;
      if (summary) {
        const cost =
          summary.missingCostEntries > 0
            ? `missing cost: ${formatMissingCostEntries(summary)}`
            : formatUsd(summary.totalCost);
        const tokens = `${formatTokenCount(summary.totalTokens)} tok`;
        const line = `💵 ${cost ? `${cost} · ` : ""}${tokens} (today)`;
        usageLine = [usageLine, line].filter(Boolean).join("\n");
      }
    } catch {
      // Optional session cost must not hide the provider usage already collected.
    }
  }
  const { getFollowupQueueDepth, resolveQueueSettings } = await loadStatusQueueRuntime();
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: statusChannel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  if (sessionKey) {
    const { alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias });
    const { buildControlledSubagentRunsReadContext, buildSubagentsStatusLine } =
      await loadStatusSubagentsRuntime();
    const subagentReadContext = await buildControlledSubagentRunsReadContext(
      requesterKey,
      statusAgentId,
      cfg,
    );
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    subagentsLine = buildSubagentsStatusLine({
      context: subagentReadContext,
      verboseEnabled,
    });
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const agentConfig = resolveAgentConfig(cfg, statusAgentId);
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider: selectedLookupProvider,
      model: selectedLookupModel,
      agentId: statusAgentId,
      sessionEntry,
    }).mode;
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(cfg, statusAgentId);
  const configuredDefaultRef = resolveDefaultModelForAgent({
    cfg,
    agentId: statusAgentId,
    allowPluginNormalization: false,
  });
  const configuredDefaultModelLabel = `${configuredDefaultRef.provider}/${configuredDefaultRef.model}`;
  const pluginHealthLine = Object.hasOwn(params, "pluginHealthLineOverride")
    ? params.pluginHealthLineOverride
    : await resolveRuntimePluginHealthLine();
  let channelFeatureLine: string | undefined;
  if (normalizeOptionalLowercaseString(statusChannel) === "telegram") {
    const telegramConfig = cfg.channels?.telegram;
    const accountId = normalizeAccountId(
      params.statusAccountId ??
        deliveryContextFromSession(sessionEntry)?.accountId ??
        sessionDeliveryOrigin(sessionEntry)?.accountId ??
        telegramConfig?.defaultAccount,
    );
    const accountConfig = resolveNormalizedAccountEntry(
      telegramConfig?.accounts,
      accountId,
      normalizeAccountId,
    );
    const richMessagesSetting = accountConfig?.richMessages ?? telegramConfig?.richMessages;
    channelFeatureLine =
      richMessagesSetting === true
        ? "Telegram rich messages: on · Bot API 10.3 sendRichMessage enabled"
        : accountConfig?.richMessages === false
          ? "Telegram rich messages: off · enable richMessages for this Telegram account"
          : "Telegram rich messages: off · set channels.telegram.richMessages=true for tables/details/rich media";
  }
  const { buildStatusMessageParts } = await loadStatusMessageRuntime();
  const configuredThinkingDefault = resolveConfiguredThinkingDefault({
    cfg,
    agentId: statusAgentId,
    provider: selectedLookupProvider,
    model: selectedLookupModel,
  });
  const catalog = owner ? (owner.isCurrent() ? owner.modelCatalog : undefined) : undefined;
  const catalogView =
    catalog &&
    createModelCatalogView({
      cfg,
      catalog: catalog.entries,
      routeVariants: catalog.routeVariants,
    });
  const contextCatalog =
    catalog && catalogView
      ? catalog.entries.map(
          (entry) =>
            catalogView.selectRuntimeEntry({
              entry,
              runtimeId: effectiveHarness ?? "openclaw",
              allowApiFallback: false,
            }).entry,
        )
      : owner
        ? []
        : (thinkingCatalog ?? []).filter((entry) =>
            entry.nativeRuntime
              ? entry.nativeRuntime === effectiveHarness
              : ["openclaw", "auto", entry.provider].includes(effectiveHarness ?? "openclaw"),
          );
  const selectedCatalogEntry = findModelInCatalog(
    contextCatalog,
    selectedLookupProvider,
    selectedLookupModel,
  );
  const initialActiveCatalogEntry = findModelInCatalog(
    contextCatalog,
    activeProvider,
    modelRefs.active.model || model,
  );
  const requestedThinkLevel =
    resolvedThinkLevel ??
    normalizeThinkLevel(sessionEntry?.thinkingLevel) ??
    configuredThinkingDefault ??
    (await resolveDefaultThinkingLevel({
      provider: selectedLookupProvider,
      model: selectedLookupModel,
      agentRuntime: effectiveHarness,
    })) ??
    "off";
  // Active profiles can forbid `off` (for example, always-thinking models). Absence means
  // there is no prepared policy fact, so status must not fall back to manifest discovery.
  const activeThinkingProfile =
    requestedThinkLevel === "off"
      ? resolveActiveProviderThinkingProfile({
          provider: selectedLookupProvider,
          context: {
            provider: selectedLookupProvider,
            modelId: selectedLookupModel,
            agentRuntime: effectiveHarness,
          },
        })
      : undefined;
  const activeProfileSupportsOff = activeThinkingProfile?.levels.some(
    (level) => level.id === "off",
  );
  const effectiveThinkLevel =
    requestedThinkLevel === "off" &&
    (activeThinkingProfile == null || activeProfileSupportsOff === true)
      ? "off"
      : (await loadThinkingLevelRuntime()).resolveSupportedThinkingLevel({
          provider: selectedLookupProvider,
          model: selectedLookupModel,
          level: requestedThinkLevel,
          catalog: thinkingCatalog,
          agentRuntime: effectiveHarness,
          // Status uses loaded provider facts unless Codex needs OpenAI's static thinking contract.
          providerPolicySource:
            normalizeOptionalLowercaseString(effectiveHarness) === "codex" &&
            ["codex", "openai"].includes(
              normalizeOptionalLowercaseString(selectedLookupProvider) ?? "",
            )
              ? "active-or-bundled"
              : "active",
        });
  const hasCommittedUsage =
    resolveFreshSessionTotalTokens(sessionEntry) !== undefined &&
    [
      sessionEntry?.inputTokens,
      sessionEntry?.outputTokens,
      sessionEntry?.cacheRead,
      sessionEntry?.cacheWrite,
    ].every((value) => value !== undefined) &&
    Boolean(sessionEntry?.model || activeModel);
  const [lifecycleTimestamps, transcriptUsage] = await Promise.all([
    resolveSessionLifecycleTimestampsAsync({
      entry: sessionEntry,
      agentId: statusAgentId,
      sessionKey,
      storePath,
    }),
    params.includeTranscriptUsage !== false && !hasCommittedUsage && sessionEntry?.sessionId
      ? import("../gateway/session-transcript-usage.js")
          .then(({ readRecentSessionUsageFromTranscriptAsync }) =>
            readRecentSessionUsageFromTranscriptAsync(
              {
                agentId: statusAgentId,
                sessionEntry,
                sessionId: sessionEntry.sessionId,
                sessionKey,
                storePath,
              },
              256 * 1024,
            ),
          )
          .catch(() => null)
      : undefined,
  ]);
  const preparedSandboxRuntime = await resolveSandboxRuntimeStatusAsync({
    cfg,
    sessionKey,
    agentId: statusAgentId,
    preparedSessionEntry: sessionEntry,
  });
  return buildStatusMessageParts({
    config: cfg,
    preparedSandboxRuntime,
    preparedTtsPreferences: params.preparedTtsPreferences ?? (await prepareTtsPreferences()),
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: params.primaryModelLabelOverride ?? `${provider}/${model}`,
        ...(agentFallbacksOverride === undefined ? {} : { fallbacks: agentFallbacksOverride }),
      },
      thinkingDefault: configuredThinkingDefault,
      verboseDefault: agentConfig?.verboseDefault ?? agentDefaults.verboseDefault,
      reasoningDefault: agentConfig?.reasoningDefault ?? agentDefaults.reasoningDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    configuredDefaultModelLabel,
    modelRefs,
    activeModel,
    selectedContextWindow: selectedCatalogEntry?.contextWindow,
    selectedContextTokens: selectedCatalogEntry?.contextTokens,
    thinkingCatalog: contextCatalog,
    runtimeContextProvider: activeRuntimeIsAuthoritative ? activeStatusProvider : undefined,
    runtimeContextTokens: initialActiveCatalogEntry?.contextTokens,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    sessionStartedAt: lifecycleTimestamps.sessionStartedAt,
    groupActivation,
    resolvedThink: effectiveThinkLevel,
    requestedThink: requestedThinkLevel,
    resolvedFast: effectiveFastMode,
    resolvedHarness: effectiveHarness,
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: selectedModelAuth,
    selectedEndpoint: selectedResolution.endpoint,
    activeModelAuth,
    uptimeValue: buildStatusUptimeValue(),
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    pluginHealthLine,
    channelFeatureLine,
    mediaDecisions: params.mediaDecisions,
    transcriptUsage,
  });
}
