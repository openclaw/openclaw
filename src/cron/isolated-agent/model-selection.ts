import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { resolveConfiguredModelPolicyAllow } from "../../agents/model-selection-shared.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.types.js";
import {
  needsThinkHydration,
  normalizeThinkingCatalogProviders,
} from "../../agents/thinking-runtime.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
/** Resolves provider/model precedence for isolated cron runs. */
import type { AgentConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import { resolveCronAgentConfig } from "./run-config.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadResolvedPublishedModelCatalogOwner,
  loadProviderScopedThinkingCatalog,
  normalizeModelSelection,
  publishedModelCatalogOwnerMatchesAgent,
  resolveAgentConfig,
  resolveAllowedModelRefCore,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveSubagentModelConfigSelectionResult,
  type ResolvedPublishedModelCatalogOwner,
} from "./run-model-selection.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
};

type CronModelSelectionSource = "default" | "subagent" | "agent" | "hook" | "payload" | "session";

type CronModelSelectionOwner = Pick<
  ResolvedPublishedModelCatalogOwner,
  "agentId" | "agentDir" | "workspaceDir" | "config" | "metadataSnapshot" | "modelCatalog"
>;

type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  owner?: CronModelSelectionOwner;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents" | "runtime">;
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
  agentId?: string;
  agentDir: string;
  workspaceDir: string;
};

/** Resolved provider/model pair plus the precedence source that selected it. */
type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
      modelSource: CronModelSelectionSource;
      configuredProfileId?: string;
      cfgWithAgentDefaults: OpenClawConfig;
      owner: CronModelSelectionOwner;
    }
  | {
      ok: false;
      error: string;
    };

function formatCronPayloadModelRejection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  modelOverride: string;
  error: string;
}): string {
  const { modelOverride, error } = params;
  if (error.startsWith("model not allowed:")) {
    const modelRef = error.slice("model not allowed:".length).trim();
    const policy = resolveConfiguredModelPolicyAllow(params);
    const policyPath = policy.configPath ?? "agents.defaults.modelPolicy.allow";
    const allowedModels = policy.refs.length
      ? policy.refs.toSorted().join(", ")
      : "(none configured)";
    return `automation model override '${modelOverride}' rejected by ${policyPath}: ${modelRef} is not in [${allowedModels}]`;
  }
  return `automation model override '${modelOverride}' rejected: ${error}`;
}

export async function resolveCronModelSelectionOwner(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  requiredAgentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  publishedRuntime?: PreparedReplyDispatchRuntime;
}): Promise<CronModelSelectionOwner> {
  const owner = params.publishedRuntime
    ? Object.freeze({
        ...params.publishedRuntime,
        metadataSnapshot: params.publishedRuntime.pluginGeneration.pluginMetadataSnapshot,
        modelCatalog:
          params.publishedRuntime.readFullModelCatalog?.() ?? params.publishedRuntime.modelCatalog,
      })
    : await loadResolvedPublishedModelCatalogOwner({
        config: params.cfg,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.agentDir ? { agentDir: params.agentDir } : {}),
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        readOnly: true,
        allowGatewaySubagentBinding: true,
      });
  if (
    params.requiredAgentId &&
    !publishedModelCatalogOwnerMatchesAgent(owner, params.requiredAgentId)
  ) {
    throw new Error(
      `cron model catalog owner changed from ${params.requiredAgentId} to ${owner.agentId}`,
    );
  }
  return owner;
}

async function resolveCronThinkingCatalog(params: {
  owner: CronModelSelectionOwner;
  provider: string;
  model: string;
  agentRuntime: string;
}): Promise<ModelCatalogEntry[]> {
  const catalog = normalizeThinkingCatalogProviders(params.owner.modelCatalog.entries);
  if (!needsThinkHydration(catalog, params.provider, params.model, params.agentRuntime)) {
    return catalog;
  }
  // Thinking capability is a per-model fact; never materialize the full live catalog on cron turns.
  const refreshed = normalizeThinkingCatalogProviders(
    await loadProviderScopedThinkingCatalog({
      config: params.owner.config,
      provider: params.provider,
      model: params.model,
      agentRuntime: params.agentRuntime,
      agentId: params.owner.agentId,
      agentDir: params.owner.agentDir,
      workspaceDir: params.owner.workspaceDir,
    }),
  );
  return findModelInCatalog(refreshed, params.provider, params.model) ? refreshed : catalog;
}

export async function resolveCronThinkingSelection(params: {
  cfg: OpenClawConfig;
  owner: CronModelSelectionOwner;
  provider: string;
  model: string;
  agentRuntime: string;
  jobThinking?: string;
  hookThinking?: string;
  sessionThinking?: string;
}) {
  const immutableThinkLevel =
    normalizeThinkLevel(params.jobThinking) ??
    normalizeThinkLevel(params.hookThinking) ??
    normalizeThinkLevel(params.sessionThinking);
  const requestedThinkLevel =
    immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      agentId: params.owner.agentId,
      provider: params.provider,
      model: params.model,
    });
  const catalog =
    requestedThinkLevel === "off" && params.agentRuntime === "openclaw"
      ? params.owner.modelCatalog.entries
      : await resolveCronThinkingCatalog(params);
  return {
    catalog,
    immutableThinkLevel,
    loadThinkingCatalog: async (provider: string, model: string, agentRuntime: string) =>
      await resolveCronThinkingCatalog({ owner: params.owner, provider, model, agentRuntime }),
    requestedThinkLevel,
  };
}

/** Resolves the effective model for an isolated cron run across defaults, agents, hooks, payload, and session state. */
export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const owner =
    params.owner ??
    (await resolveCronModelSelectionOwner({
      cfg: params.cfg,
      ...(params.agentId
        ? {
            agentId: params.agentId,
            requiredAgentId: params.agentId,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
          }
        : {}),
    }));
  const ownerAgentId = owner.agentId;
  const ownerAgentConfigOverride = params.agentConfigOverride
    ? owner.config === params.cfg && (!params.agentId || ownerAgentId === params.agentId)
      ? params.agentConfigOverride
      : resolveAgentConfig(owner.config, ownerAgentId)
    : undefined;
  const { cfgWithAgentDefaults } = resolveCronAgentConfig({
    config: owner.config,
    agentConfigOverride: ownerAgentConfigOverride,
  });
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    agentId: ownerAgentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    manifestPlugins: owner.metadataSnapshot,
  });
  // Overrides keep the owner's agent policy; flattened defaults only select the default model.
  const selectionParams = {
    cfg: owner.config,
    catalog: owner.modelCatalog.entries,
    defaultProvider: resolvedDefault.provider,
    defaultModel: resolvedDefault,
    agentId: ownerAgentId,
    manifestPlugins: owner.metadataSnapshot,
  };
  const selection = (
    ref: { provider: string; model: string },
    modelSource: CronModelSelectionSource,
    profileModel?: string,
  ): Extract<ResolveCronModelSelectionResult, { ok: true }> => {
    const configuredProfileId = splitTrailingAuthProfile(profileModel ?? "").profile;
    return {
      ok: true,
      provider: ref.provider,
      model: ref.model,
      modelSource,
      ...(configuredProfileId ? { configuredProfileId } : {}),
      cfgWithAgentDefaults,
      owner,
    };
  };
  const override = (
    raw: string | undefined,
    source: "payload" | "session" | "agent" | "subagent",
  ): ResolveCronModelSelectionResult | undefined => {
    if (!raw) {
      return undefined;
    }
    const resolved = resolveAllowedModelRefCore({ ...selectionParams, raw });
    if (!("error" in resolved)) {
      return selection(resolved.ref, source, source === "session" ? undefined : raw);
    }
    // Payload overrides are explicit; invalid advisory config falls through.
    return source === "payload"
      ? {
          ok: false,
          error: formatCronPayloadModelRejection({
            cfg: owner.config,
            agentId: ownerAgentId,
            modelOverride: raw,
            error: resolved.error,
          }),
        }
      : undefined;
  };

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const payloadSelection = override(
    typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined,
    "payload",
  );
  if (payloadSelection) {
    return payloadSelection;
  }

  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: owner.config,
        defaultProvider: DEFAULT_PROVIDER,
        manifestPlugins: owner.metadataSnapshot,
      })
    : null;
  if (
    hooksGmailModelRef &&
    getModelRefStatus({ ...selectionParams, ref: hooksGmailModelRef }).allowed
  ) {
    return selection(hooksGmailModelRef, "hook", owner.config.hooks?.gmail?.model);
  }

  const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
  const sessionSelection = override(
    sessionModelOverride
      ? `${params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider}/${sessionModelOverride}`
      : undefined,
    "session",
  );
  if (sessionSelection) {
    return sessionSelection;
  }

  const subagentSelection = resolveSubagentModelConfigSelectionResult({
    cfg: owner.config,
    agentId: ownerAgentId,
    agentConfigOverride: ownerAgentConfigOverride,
  });
  return (
    override(
      normalizeModelSelection(subagentSelection?.raw),
      subagentSelection?.source === "agent" ? "agent" : "subagent",
    ) ??
    selection(
      resolvedDefault,
      "default",
      resolveAgentModelPrimaryValue(cfgWithAgentDefaults.agents?.defaults?.model),
    )
  );
}
