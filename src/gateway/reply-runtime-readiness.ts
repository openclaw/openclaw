import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import {
  ensureAuthProfileStore,
  resolvePreparedAuthProfileOrder,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../agents/model-auth.js";
import { prepareReplyRuntimeModelCatalog } from "../agents/model-catalog.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import {
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../agents/model-selection.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { prepareOpenClawToolsRuntime } from "../agents/openclaw-tools.runtime.js";
import { preparePreparedPiRunBootstrapState } from "../agents/pi-embedded-runner/prepared-bootstrap-state.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import { prepareSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import { prepareWebFetchToolRuntime } from "../agents/tools/web-fetch.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveProviderAuthProfileId,
  resolveProviderRuntimePlugin,
} from "../plugins/provider-hook-runtime.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { prepareWebContentExtractors } from "../web-fetch/content-extractors.runtime.js";
import { prepareWebFetchDefinition } from "../web-fetch/runtime.js";
import { prepareWebSearchDefinition } from "../web-search/runtime.js";
import {
  markReplyRuntimePluginRegistryPrepared,
  markReplyRuntimeProviderAuthPrepared,
  markReplyRuntimeProviderPrepared,
} from "./reply-runtime-readiness-monitor.js";

type Awaitable<T> = T | Promise<T>;

type ReplyRuntimeReadinessPhaseName =
  | "runtime-plugin-registry"
  | "selected-model-metadata"
  | "selected-provider-runtime"
  | "selected-provider-auth"
  | "tool-contracts";

type StartupTrace = {
  measure?: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

export type ReplyRuntimeReadinessPhaseResult = {
  phase: ReplyRuntimeReadinessPhaseName;
  status: "ready" | "degraded";
  durationMs: number;
  detail?: string;
};

export type ReplyRuntimeReadinessResult = {
  status: "ready" | "degraded";
  provider: string;
  model: string;
  phases: ReplyRuntimeReadinessPhaseResult[];
  reasons: string[];
};

async function measurePhase<T>(
  startupTrace: StartupTrace | undefined,
  traceName: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace?.measure ? await startupTrace.measure(traceName, run) : await run();
}

function resolveSelectedHarnessAuthProfileId(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  workspaceDir: string;
  harnessId: string;
}): string | undefined {
  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessId,
    allowHarnessAuthProfileForwarding: true,
  });
  if (!runtimeAuthPlan.harnessAuthProvider) {
    return undefined;
  }
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return resolvePreparedAuthProfileOrder({
    cfg: params.cfg,
    store: authStore,
    provider: runtimeAuthPlan.harnessAuthProvider,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    primeReplyRuntimeCache: true,
  })[0]?.trim();
}

function collectReplyRuntimeWarmTargets(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultAgentId: string;
  defaultWorkspaceDir?: string;
}): Array<{
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  provider: string;
  model: string;
}> {
  const targets = new Map<
    string,
    {
      agentId: string;
      agentDir: string;
      workspaceDir: string;
      sessionKey: string;
      provider: string;
      model: string;
    }
  >();
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const configuredProviderModels: string[] = [];
  const addConfiguredProviderModels = () => {
    const configuredProviders = params.cfg.models?.providers;
    if (!configuredProviders || typeof configuredProviders !== "object") {
      return;
    }
    for (const [provider, config] of Object.entries(configuredProviders)) {
      if (!Array.isArray(config?.models)) {
        continue;
      }
      for (const model of config.models) {
        if (typeof model?.id === "string" && model.id.trim()) {
          configuredProviderModels.push(`${provider}/${model.id}`);
        }
      }
    }
  };
  addConfiguredProviderModels();
  const addTarget = (
    agentId: string,
    agentDir: string,
    workspaceDir: string,
    sessionKey: string,
    provider: string,
    model: string,
  ) => {
    const providerId = provider.trim();
    const modelId = model.trim();
    if (!providerId || !modelId) {
      return;
    }
    targets.set(`${agentId}::${providerId}/${modelId}`, {
      agentId,
      agentDir,
      workspaceDir,
      sessionKey,
      provider: providerId,
      model: modelId,
    });
  };
  const addRawRef = (
    agentId: string,
    agentDir: string,
    workspaceDir: string,
    sessionKey: string,
    raw: string | undefined,
    providerOverride?: string,
  ) => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return;
    }
    const parsed = resolveModelRefFromString({
      cfg: params.cfg,
      raw: providerOverride?.trim() ? `${providerOverride}/${trimmed}` : trimmed,
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (parsed?.ref) {
      addTarget(agentId, agentDir, workspaceDir, sessionKey, parsed.ref.provider, parsed.ref.model);
    }
  };

  for (const agentId of listAgentIds(params.cfg)) {
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const workspaceDir =
      agentId === params.defaultAgentId && params.defaultWorkspaceDir
        ? params.defaultWorkspaceDir
        : resolveAgentWorkspaceDir(params.cfg, agentId);
    const sessionKey = buildAgentMainSessionKey({
      agentId,
      mainKey: params.cfg.session?.mainKey,
    });
    const selected = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId,
    });
    addTarget(agentId, agentDir, workspaceDir, sessionKey, selected.provider, selected.model);

    const fallbackModels =
      resolveAgentModelFallbacksOverride(params.cfg, agentId) ??
      resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
    for (const fallback of fallbackModels) {
      addRawRef(agentId, agentDir, workspaceDir, sessionKey, fallback);
    }
    for (const configuredProviderModel of configuredProviderModels) {
      addRawRef(agentId, agentDir, workspaceDir, sessionKey, configuredProviderModel);
    }

    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    for (const entry of Object.values(store)) {
      const persisted = resolvePersistedSelectedModelRef({
        defaultProvider: params.defaultProvider,
        runtimeProvider: entry.modelProvider,
        runtimeModel: entry.model,
        overrideProvider: entry.providerOverride,
        overrideModel: entry.modelOverride,
        allowPluginNormalization: true,
      });
      if (persisted) {
        addTarget(agentId, agentDir, workspaceDir, sessionKey, persisted.provider, persisted.model);
      }
    }
  }

  return [...targets.values()];
}

function resolvePiReplyRuntimeProfileCandidates(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
}): string[] {
  if (shouldPreferExplicitConfigApiKeyAuth(params.cfg, params.provider)) {
    return [];
  }
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOrder = resolvePreparedAuthProfileOrder({
    cfg: params.cfg,
    store: authStore,
    provider: params.provider,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    primeReplyRuntimeCache: true,
  });
  const providerPreferredProfileId = resolveProviderAuthProfileId({
    provider: params.provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    context: {
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: params.provider,
      modelId: params.modelId,
      preferredProfileId: undefined,
      lockedProfileId: undefined,
      profileOrder,
      authStore,
    },
  });
  const orderedProfiles =
    providerPreferredProfileId && profileOrder.includes(providerPreferredProfileId)
      ? [
          providerPreferredProfileId,
          ...profileOrder.filter((profileId) => profileId !== providerPreferredProfileId),
        ]
      : profileOrder;
  return orderedProfiles;
}

async function warmPreparedReplyRuntimeWebSurfaces(config: OpenClawConfig): Promise<void> {
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  prepareWebSearchDefinition({
    config,
    runtimeWebSearch: runtimeWebTools?.search,
    preferRuntimeProviders: true,
  });
  prepareWebFetchDefinition({
    config,
    runtimeWebFetch: runtimeWebTools?.fetch,
    preferRuntimeProviders: true,
  });
  await prepareWebContentExtractors({ config });
}

export async function prepareReplyRuntimeForChannels(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: StartupTrace;
}): Promise<ReplyRuntimeReadinessResult> {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const phases: ReplyRuntimeReadinessPhaseResult[] = [];
  const reasons: string[] = [];
  const selected = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warmTargets = collectReplyRuntimeWarmTargets({
    cfg: params.cfg,
    defaultProvider: selected.provider,
    defaultAgentId,
    defaultWorkspaceDir: params.workspaceDir,
  });
  const warmAgents = new Map<
    string,
    { agentDir: string; workspaceDir: string; sessionKey: string }
  >();
  for (const target of warmTargets) {
    warmAgents.set(target.agentId, {
      agentDir: target.agentDir,
      workspaceDir: target.workspaceDir,
      sessionKey: target.sessionKey,
    });
  }

  const runPhase = async (
    phase: ReplyRuntimeReadinessPhaseName,
    detail: string,
    run: () => Promise<void>,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    try {
      await measurePhase(params.startupTrace, `reply-runtime-readiness.${phase}`, run);
      phases.push({
        phase,
        status: "ready",
        durationMs: Date.now() - startedAt,
        detail,
      });
      return true;
    } catch (error) {
      const reason = `${phase}: ${formatErrorMessage(error)}`;
      phases.push({
        phase,
        status: "degraded",
        durationMs: Date.now() - startedAt,
        detail: reason,
      });
      reasons.push(reason);
      return false;
    }
  };

  if (
    !(await runPhase("runtime-plugin-registry", "loaded runtime plugin registry", async () => {
      for (const warmAgent of warmAgents.values()) {
        ensureRuntimePluginsLoaded({
          config: params.cfg,
          workspaceDir: warmAgent.workspaceDir,
          source: "gateway.reply-runtime-readiness.runtime-plugin-registry",
        });
      }
      markReplyRuntimePluginRegistryPrepared();
    }))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }
  if (
    !(await runPhase(
      "selected-model-metadata",
      `prepared metadata for ${warmTargets.length} reply model target(s) across ${warmAgents.size} agent(s)`,
      async () => {
        const catalog = await prepareReplyRuntimeModelCatalog({ config: params.cfg });
        for (const target of warmTargets) {
          if (
            !catalog.some(
              (entry) => entry.provider === target.provider && entry.id === target.model,
            )
          ) {
            throw new Error(
              `Reply model ${target.provider}/${target.model} is not available after readiness model preparation.`,
            );
          }
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "selected-provider-runtime",
      `activated provider runtimes for ${new Set(warmTargets.map((target) => `${target.workspaceDir}::${target.provider}`)).size} workspace/provider target(s) across ${warmAgents.size} agent(s)`,
      async () => {
        for (const target of warmTargets) {
          const ownerPluginIds =
            resolveOwningPluginIdsForProvider({
              provider: target.provider,
              config: params.cfg,
              workspaceDir: target.workspaceDir,
              env: process.env,
            }) ?? [];
          if (ownerPluginIds.length === 0) {
            continue;
          }
          const plugin = resolveProviderRuntimePlugin({
            provider: target.provider,
            config: params.cfg,
            workspaceDir: target.workspaceDir,
            env: process.env,
          });
          if (!plugin) {
            throw new Error(`No provider runtime resolved for ${target.provider}.`);
          }
          markReplyRuntimeProviderPrepared(target.provider);
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "selected-provider-auth",
      `prepared runtime auth for ${warmTargets.length} reply model target(s) across ${warmAgents.size} agent(s)`,
      async () => {
        for (const target of warmTargets) {
          const selectedHarness = selectAgentHarness({
            provider: target.provider,
            modelId: target.model,
            config: params.cfg,
            agentId: target.agentId,
          });
          if (!selectedHarness) {
            throw new Error(`No harness selected for ${target.provider}/${target.model}.`);
          }
          if (selectedHarness.id !== "pi") {
            const authProfileId = resolveSelectedHarnessAuthProfileId({
              cfg: params.cfg,
              agentDir: target.agentDir,
              provider: target.provider,
              workspaceDir: target.workspaceDir,
              harnessId: selectedHarness.id,
            });
            if (selectedHarness.prepareReplyRuntime) {
              await selectedHarness.prepareReplyRuntime({
                config: params.cfg,
                agentDir: target.agentDir,
                workspaceDir: target.workspaceDir,
                provider: target.provider,
                modelId: target.model,
                ...(authProfileId ? { authProfileId } : {}),
              });
            }
            markReplyRuntimeProviderAuthPrepared(target.provider);
            continue;
          }
          const prepared = await prepareSimpleCompletionModel({
            cfg: params.cfg,
            provider: target.provider,
            modelId: target.model,
            agentDir: target.agentDir,
            workspaceDir: target.workspaceDir,
            allowMissingApiKeyModes: ["aws-sdk"],
            primeReplyRuntimeCache: true,
          });
          if ("error" in prepared) {
            throw new Error(prepared.error);
          }
          const dynamicPrepared = await prepareSimpleCompletionModel({
            cfg: params.cfg,
            provider: target.provider,
            modelId: target.model,
            agentDir: target.agentDir,
            workspaceDir: target.workspaceDir,
            allowMissingApiKeyModes: ["aws-sdk"],
            skipPiDiscovery: true,
            primeReplyRuntimeCache: true,
          });
          if ("error" in dynamicPrepared) {
            throw new Error(dynamicPrepared.error);
          }
          preparePreparedPiRunBootstrapState({
            config: params.cfg,
            agentDir: target.agentDir,
            workspaceDir: target.workspaceDir,
            provider: target.provider,
            modelId: target.model,
          });
          for (const profileId of resolvePiReplyRuntimeProfileCandidates({
            cfg: params.cfg,
            agentDir: target.agentDir,
            workspaceDir: target.workspaceDir,
            provider: target.provider,
            modelId: target.model,
          })) {
            const profilePrepared = await prepareSimpleCompletionModel({
              cfg: params.cfg,
              provider: target.provider,
              modelId: target.model,
              agentDir: target.agentDir,
              workspaceDir: target.workspaceDir,
              ...(profileId ? { profileId } : {}),
              allowMissingApiKeyModes: ["aws-sdk"],
              primeReplyRuntimeCache: true,
            });
            if ("error" in profilePrepared) {
              throw new Error(profilePrepared.error);
            }
          }
          markReplyRuntimeProviderAuthPrepared(target.provider);
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "tool-contracts",
      `prepared stable core and plugin tool contracts for ${warmAgents.size} agent(s)`,
      async () => {
        await prepareOpenClawToolsRuntime();
        await prepareWebFetchToolRuntime();
        for (const [agentId, warmAgent] of warmAgents) {
          createOpenClawTools({
            config: params.cfg,
            workspaceDir: warmAgent.workspaceDir,
            agentDir: warmAgent.agentDir,
            agentSessionKey: warmAgent.sessionKey,
            requesterAgentIdOverride: agentId,
          });
        }
        await warmPreparedReplyRuntimeWebSurfaces(params.cfg);
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  return {
    status: "ready",
    provider: selected.provider,
    model: selected.model,
    phases,
    reasons,
  };
}
