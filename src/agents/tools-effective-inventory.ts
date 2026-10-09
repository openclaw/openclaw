/**
 * Effective tool inventory resolver.
 *
 * Builds model-visible tool lists after profile, provider, plugin, policy, and compatibility filters.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/config.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import { extractModelCompat } from "../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeProviderTransportWithPlugin } from "../plugins/provider-runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.js";
import { hasAnyAuthProfileStoreSourceAsync } from "./auth-profiles/source-check.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { resolveBundledStaticCatalogModel } from "./embedded-agent-runner/model.static-catalog.js";
import { normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { createToolAccessDiagnostics } from "./tool-access-diagnostics.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { buildRuntimeCompatibleToolInventory } from "./tools-effective-inventory-build.js";
import { buildEffectiveToolInventoryGroups } from "./tools-effective-inventory-groups.js";
import type {
  EffectiveToolInventoryNotice,
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryResult,
  ResolveEffectiveToolInventoryParams,
} from "./tools-effective-inventory.types.js";

function listIncludesTool(list: string[] | undefined, toolName: string): boolean {
  if (!Array.isArray(list)) {
    return false;
  }
  const normalizedToolName = normalizeToolPolicyName(toolName);
  return list.some((entry) => normalizeToolPolicyName(entry) === normalizedToolName);
}

function policyDeniesTool(policy: { deny?: string[] } | undefined, toolName: string): boolean {
  return (
    listIncludesTool(policy?.deny, toolName) ||
    listIncludesTool(policy?.deny, "group:ui") ||
    listIncludesTool(policy?.deny, "group:openclaw")
  );
}

function hasExplicitBrowserIntent(cfg: OpenClawConfig): boolean {
  return cfg.browser?.enabled !== false && Boolean(cfg.browser || cfg.plugins?.entries?.browser);
}

function buildToolInventoryNotices(params: {
  cfg: OpenClawConfig;
  profile: string;
  entries: EffectiveToolInventoryEntry[];
  effectivePolicy: ReturnType<typeof resolveConversationCapabilityProfile>["policy"];
}): EffectiveToolInventoryNotice[] | undefined {
  const hasBrowserTool = params.entries.some(
    (entry) => normalizeToolPolicyName(entry.id) === "browser",
  );
  if (hasBrowserTool || !hasExplicitBrowserIntent(params.cfg)) {
    return undefined;
  }

  // Browser can be configured yet absent after policy/profile/plugin filtering; surface why.
  const browserDenied = [
    params.effectivePolicy.globalPolicy,
    params.effectivePolicy.globalProviderPolicy,
    params.effectivePolicy.agentPolicy,
    params.effectivePolicy.agentProviderPolicy,
  ].some((policy) => policyDeniesTool(policy, "browser"));
  if (browserDenied) {
    return [
      {
        id: "browser-denied-by-policy",
        severity: "info",
        message:
          "Browser is configured, but this session does not expose the browser tool because tool policy denies it. Remove the browser deny entry to use browser automation.",
      },
    ];
  }

  if (params.profile !== "full") {
    return [
      {
        id: "browser-filtered-by-profile",
        severity: "info",
        message:
          'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"] or agents.entries.*.tools.alsoAllow: ["browser"]; tools.subagents.tools.allow alone cannot add it back after profile filtering.',
      },
    ];
  }

  if (
    Array.isArray(params.cfg.plugins?.allow) &&
    !listIncludesTool(params.cfg.plugins.allow, "browser")
  ) {
    return [
      {
        id: "browser-plugin-not-allowed",
        severity: "warning",
        message:
          'Browser is configured, but plugins.allow does not include browser. Add "browser" to plugins.allow or remove the restrictive plugin allowlist.',
      },
    ];
  }

  return undefined;
}

function resolveConfiguredFallbackApi(
  providerConfig: { api?: string; baseUrl?: string } | undefined,
): string {
  const explicitApi = normalizeOptionalString(providerConfig?.api);
  if (explicitApi) {
    return explicitApi;
  }
  return normalizeOptionalString(providerConfig?.baseUrl)
    ? "openai-completions"
    : "openai-responses";
}

/** Resolves configured or bundled metadata without starting provider discovery. */
function resolveStaticToolInventoryRuntimeModelContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
}): { modelApi?: string; runtimeModel?: ProviderRuntimeModel } {
  const provider = normalizeProviderId(params.modelProvider ?? "");
  const modelId = params.modelId?.trim() ?? "";
  if (!provider || !modelId) {
    return {};
  }
  const agentId = params.agentId?.trim() || resolveSessionAgentId({ config: params.cfg });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const configuredModel = findConfiguredProviderModel(providerConfig, provider, modelId, (id) =>
    normalizeLowercaseStringOrEmpty(normalizeStaticProviderModelId(provider, id)),
  );
  const bundledStaticModel = resolveBundledStaticCatalogModel({
    provider,
    modelId,
    cfg: params.cfg,
    workspaceDir,
  });
  let runtimeModel: ProviderRuntimeModel;
  if (configuredModel) {
    // Configured model entries override the bundled catalog but inherit missing transport details.
    const configuredApi =
      normalizeOptionalString(configuredModel.api) ??
      normalizeOptionalString(providerConfig?.api) ??
      normalizeOptionalString(bundledStaticModel?.api) ??
      resolveConfiguredFallbackApi(providerConfig);
    runtimeModel = {
      ...bundledStaticModel,
      ...configuredModel,
      id: modelId,
      name: configuredModel.name ?? bundledStaticModel?.name ?? configuredModel.id,
      provider,
      api: configuredApi,
      baseUrl:
        normalizeOptionalString(configuredModel.baseUrl) ??
        normalizeOptionalString(providerConfig?.baseUrl) ??
        normalizeOptionalString(bundledStaticModel?.baseUrl),
    } as ProviderRuntimeModel;
  } else if (bundledStaticModel) {
    runtimeModel = {
      ...bundledStaticModel,
      api: normalizeOptionalString(providerConfig?.api) ?? bundledStaticModel.api,
      baseUrl: normalizeOptionalString(providerConfig?.baseUrl) ?? bundledStaticModel.baseUrl,
    } as ProviderRuntimeModel;
  } else {
    return {};
  }
  const normalized = normalizeProviderTransportWithPlugin({
    provider,
    modelId: runtimeModel.id,
    config: params.cfg,
    workspaceDir,
    context: {
      config: params.cfg,
      workspaceDir,
      provider,
      modelId: runtimeModel.id,
      api: runtimeModel.api,
      baseUrl: runtimeModel.baseUrl,
    },
  });
  if (normalized) {
    runtimeModel = {
      ...runtimeModel,
      api: normalized.api ?? runtimeModel.api,
      baseUrl: normalized.baseUrl ?? runtimeModel.baseUrl,
    } as ProviderRuntimeModel;
  }
  return {
    modelApi: runtimeModel.api,
    runtimeModel,
  };
}

type ToolInventoryRuntimeModelContext = ReturnType<
  typeof resolveStaticToolInventoryRuntimeModelContext
>;

/** Keeps dynamic model hooks owned and scoped until inventory projection finishes. */
export async function acquireEffectiveToolInventoryRuntimeModelContext(
  params: Parameters<typeof resolveStaticToolInventoryRuntimeModelContext>[0],
): Promise<
  { run: <T>(project: (context: ToolInventoryRuntimeModelContext) => T) => T } & AsyncDisposable
> {
  const staticContext = resolveStaticToolInventoryRuntimeModelContext(params);
  if (staticContext.runtimeModel) {
    return { run: (project) => project(staticContext), [Symbol.asyncDispose]: async () => {} };
  }

  const provider = normalizeProviderId(params.modelProvider ?? "");
  const modelId = params.modelId?.trim() ?? "";
  if (!provider || !modelId) {
    return { run: (project) => project({}), [Symbol.asyncDispose]: async () => {} };
  }
  const agentId = params.agentId?.trim() || resolveSessionAgentId({ config: params.cfg });
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const lease = await acquireReadOnlyPreparedModelRuntime(
    {
      agentId,
      agentDir,
      config: params.cfg,
      workspaceDir,
      // The selected provider owner must join the generation before dynamic hooks resolve.
      loadRuntimePlugins: true,
      runtimePluginSelections: [{ provider, modelId, agentId }],
      // Gateway-hosted reads borrow the admitting Gateway's live plugin instances
      // instead of synchronously loading another copy on every cold refresh.
      allowGatewaySubagentBinding: true,
    },
    { catalogMode: "static" },
  );
  let transferred = false;
  try {
    const stores = lease.snapshot.createStores();
    const resolved = await resolveModelAsync(provider, modelId, agentDir, params.cfg, {
      agentId,
      workspaceDir,
      authStorage: stores.authStorage,
      modelRegistry: stores.modelRegistry,
      preparedModelRuntime: lease.snapshot,
    });
    const runtimeModel = resolved.model as ProviderRuntimeModel | undefined;
    if (!runtimeModel) {
      return { run: (project) => project({}), [Symbol.asyncDispose]: async () => {} };
    }
    const context = { modelApi: runtimeModel.api, runtimeModel };
    let released = false;
    let disposal: Promise<void> | undefined;
    const acquired = {
      run: <T>(project: (context: ToolInventoryRuntimeModelContext) => T): T => {
        if (released) {
          throw new Error("Tool inventory model context has been released");
        }
        return withPluginRuntimeGenerationScope(lease.snapshot, () => project(context));
      },
      [Symbol.asyncDispose]() {
        released = true;
        return (disposal ??= lease[Symbol.asyncDispose]());
      },
    };
    transferred = true;
    return acquired;
  } finally {
    if (!transferred) {
      await lease[Symbol.asyncDispose]();
    }
  }
}

/** Resolves compatibility metadata explicitly configured for a provider/model pair. */
export function resolveConfiguredModelCompat(params: {
  cfg: OpenClawConfig;
  modelProvider?: string;
  modelId?: string;
}) {
  const provider = normalizeProviderId(params.modelProvider ?? "");
  const modelId = params.modelId?.trim() ?? "";
  if (!provider || !modelId) {
    return undefined;
  }
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const match = findConfiguredProviderModel(providerConfig, provider, modelId, (id) =>
    normalizeLowercaseStringOrEmpty(normalizeStaticProviderModelId(provider, id)),
  );
  return extractModelCompat(match);
}

/** Resolves the grouped effective tool inventory and user-visible filtering notices. */
export async function resolveEffectiveToolInventory(
  params: ResolveEffectiveToolInventoryParams,
): Promise<EffectiveToolInventoryResult> {
  const agentId =
    params.agentId?.trim() ||
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);
  const authProfileStoreSource = await hasAnyAuthProfileStoreSourceAsync(agentDir);
  const runtimeModelContext =
    Object.hasOwn(params, "modelApi") || Object.hasOwn(params, "runtimeModel")
      ? {
          modelApi: params.modelApi ?? params.runtimeModel?.api,
          runtimeModel: params.runtimeModel,
        }
      : resolveStaticToolInventoryRuntimeModelContext({
          cfg: params.cfg,
          agentId,
          agentDir,
          workspaceDir,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
        });
  const modelCompat = resolveConfiguredModelCompat({
    cfg: params.cfg,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });

  const capabilityProfile =
    params.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      ...params,
      config: params.cfg,
      agentId,
      agentAccountId: params.accountId,
    });
  const diagnostics = createToolAccessDiagnostics({ profiles: capabilityProfile.policy.profiles });
  const effectiveTools = await createOpenClawCodingToolsInternalAsync(
    {
      ...params,
      conversationCapabilityProfile: capabilityProfile,
      authProfileStoreSource,
      agentId,
      workspaceDir,
      agentDir,
      config: params.cfg,
      modelApi: runtimeModelContext.modelApi,
      modelBaseUrl: runtimeModelContext.runtimeModel?.baseUrl,
      modelCompat,
      senderName: params.senderName ?? undefined,
      senderUsername: params.senderUsername ?? undefined,
      senderE164: params.senderE164 ?? undefined,
      agentAccountId: params.accountId ?? undefined,
      groupId: params.groupId ?? undefined,
      groupChannel: params.groupChannel ?? undefined,
      groupSpace: params.groupSpace ?? undefined,
      allowGatewaySubagentBinding: true,
      // Preview every enabled plugin tool even when the session's model lease
      // narrowed its runtime generation to the selected model owners.
      pluginToolSelectionScope: "enabled",
    },
    undefined,
    diagnostics.onFilter,
  );
  const projectedInventory = buildRuntimeCompatibleToolInventory({
    tools: effectiveTools,
    cfg: params.cfg,
    workspaceDir,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    modelApi: runtimeModelContext.modelApi,
    runtimeModel: runtimeModelContext.runtimeModel,
  });
  const effectivePolicy = capabilityProfile.policy;
  const profile = effectivePolicy.providerProfile ?? effectivePolicy.profile ?? "full";
  const entries = projectedInventory.entries;
  const notices = [
    ...projectedInventory.notices,
    ...(buildToolInventoryNotices({ cfg: params.cfg, profile, entries, effectivePolicy }) ?? []),
  ];
  const groups = buildEffectiveToolInventoryGroups(entries);

  return {
    agentId,
    profile,
    groups,
    toolAccess: diagnostics.finish(entries.map((entry) => entry.id)),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
