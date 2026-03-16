import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { isRemoteEnvironment } from "./oauth-env.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import type { OnboardOptions } from "./onboard-types.js";
import {
  applyDefaultModel,
  mergeConfigPatch,
  pickAuthMethod,
  resolveProviderMatch,
} from "./provider-auth-helpers.js";

export type PluginProviderAuthChoiceOptions = {
  authChoice: string;
  pluginId: string;
  providerId: string;
  methodId?: string;
  label: string;
};

function restoreConfiguredPrimaryModel(
  nextConfig: ApplyAuthChoiceParams["config"],
  originalConfig: ApplyAuthChoiceParams["config"],
): ApplyAuthChoiceParams["config"] {
  const originalModel = originalConfig.agents?.defaults?.model;
  const nextAgents = nextConfig.agents;
  const nextDefaults = nextAgents?.defaults;
  if (!nextDefaults) {
    return nextConfig;
  }
  if (originalModel !== undefined) {
    return {
      ...nextConfig,
      agents: {
        ...nextAgents,
        defaults: {
          ...nextDefaults,
          model: originalModel,
        },
      },
    };
  }
  const { model: _model, ...restDefaults } = nextDefaults;
  return {
    ...nextConfig,
    agents: {
      ...nextAgents,
      defaults: restDefaults,
    },
  };
}

async function loadPluginProviderRuntime() {
  return import("./auth-choice.apply.plugin-provider.runtime.js");
}

export async function runProviderPluginAuthMethod(params: {
  config: ApplyAuthChoiceParams["config"];
  runtime: ApplyAuthChoiceParams["runtime"];
  prompter: ApplyAuthChoiceParams["prompter"];
  method: ProviderAuthMethod;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  emitNotes?: boolean;
  secretInputMode?: OnboardOptions["secretInputMode"];
  allowSecretRefPrompt?: boolean;
  opts?: Partial<OnboardOptions>;
}): Promise<{ config: ApplyAuthChoiceParams["config"]; defaultModel?: string }> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const defaultAgentId = resolveDefaultAgentId(params.config);
  const agentDir =
    params.agentDir ??
    (agentId === defaultAgentId
      ? resolveOpenClawAgentDir()
      : resolveAgentDir(params.config, agentId));
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, agentId) ??
    resolveDefaultAgentWorkspaceDir();

  const isRemote = isRemoteEnvironment();
  const result = await params.method.run({
    config: params.config,
    agentDir,
    workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    opts: params.opts,
    secretInputMode: params.secretInputMode,
    allowSecretRefPrompt: params.allowSecretRefPrompt,
    isRemote,
    openUrl: async (url) => {
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts),
    },
  });

  let nextConfig = params.config;
  if (result.configPatch) {
    nextConfig = mergeConfigPatch(nextConfig, result.configPatch);
  }

  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: profile.credential.type === "token" ? "token" : profile.credential.type,
      ...("email" in profile.credential && profile.credential.email
        ? { email: profile.credential.email }
        : {}),
    });
  }

  if (params.emitNotes !== false && result.notes && result.notes.length > 0) {
    await params.prompter.note(result.notes.join("\n"), "Provider notes");
  }

  return {
    config: nextConfig,
    defaultModel: result.defaultModel,
  };
}

export async function applyAuthChoiceLoadedPluginProvider(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const workspaceDir =
    resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const { resolvePluginProviders, resolveProviderPluginChoice, runProviderModelSelectedHook } =
    await loadPluginProviderRuntime();
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const resolved = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  if (!resolved) {
    return null;
  }

  const applied = await runProviderPluginAuthMethod({
    config: params.config,
    runtime: params.runtime,
    prompter: params.prompter,
    method: resolved.method,
    agentDir: params.agentDir,
    agentId: params.agentId,
    workspaceDir,
    secretInputMode: params.opts?.secretInputMode,
    allowSecretRefPrompt: false,
    opts: params.opts,
  });

  let nextConfig = applied.config;
  let agentModelOverride: string | undefined;
  if (applied.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, applied.defaultModel);
      await runProviderModelSelectedHook({
        config: nextConfig,
        model: applied.defaultModel,
        prompter: params.prompter,
        agentDir: params.agentDir,
        workspaceDir,
      });
      await params.prompter.note(
        `Default model set to ${applied.defaultModel}`,
        "Model configured",
      );
      return { config: nextConfig };
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    agentModelOverride = applied.defaultModel;
  }

  return { config: nextConfig, agentModelOverride };
}

export async function applyAuthChoicePluginProvider(
  params: ApplyAuthChoiceParams,
  options: PluginProviderAuthChoiceOptions,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== options.authChoice) {
    return null;
  }

  const enableResult = enablePluginInConfig(params.config, options.pluginId);
  let nextConfig = enableResult.config;
  if (!enableResult.enabled) {
    await params.prompter.note(
      `${options.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
      options.label,
    );
    return { config: nextConfig };
  }

  const agentId = params.agentId ?? resolveDefaultAgentId(nextConfig);
  const defaultAgentId = resolveDefaultAgentId(nextConfig);
  const agentDir =
    params.agentDir ??
    (agentId === defaultAgentId ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId));
  const workspaceDir =
    resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();

  const { resolvePluginProviders, runProviderModelSelectedHook } =
    await loadPluginProviderRuntime();
  const providers = resolvePluginProviders({
    config: nextConfig,
    workspaceDir,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const provider = resolveProviderMatch(providers, options.providerId);
  if (!provider) {
    await params.prompter.note(
      `${options.label} auth plugin is not available. Enable it and re-run the wizard.`,
      options.label,
    );
    return { config: nextConfig };
  }

  const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
  if (!method) {
    await params.prompter.note(`${options.label} auth method missing.`, options.label);
    return { config: nextConfig };
  }

  const applied = await runProviderPluginAuthMethod({
    config: nextConfig,
    runtime: params.runtime,
    prompter: params.prompter,
    method,
    agentDir,
    agentId,
    workspaceDir,
    secretInputMode: params.opts?.secretInputMode,
    allowSecretRefPrompt: false,
    opts: params.opts,
  });
  nextConfig = applied.config;

  let agentModelOverride: string | undefined;
  if (applied.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, applied.defaultModel);
      await runProviderModelSelectedHook({
        config: nextConfig,
        model: applied.defaultModel,
        prompter: params.prompter,
        agentDir,
        workspaceDir,
      });
      await params.prompter.note(
        `Default model set to ${applied.defaultModel}`,
        "Model configured",
      );
    } else {
      nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    }
    if (!params.setDefaultModel && params.agentId) {
      agentModelOverride = applied.defaultModel;
      await params.prompter.note(
        `Default model set to ${applied.defaultModel} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
  }

  return { config: nextConfig, agentModelOverride };
}
