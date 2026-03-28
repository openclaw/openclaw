import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { enablePluginInConfig } from "../../../plugins/enable.js";
import { resolvePreferredProviderForAuthChoice } from "../../../plugins/provider-auth-choice-preference.js";
import type {
  ProviderAuthOptionBag,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createLazyRuntimeSurface } from "../../../shared/lazy-runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

async function loadPluginProviderRuntime() {
  return import("./auth-choice.plugin-providers.runtime.js");
}

const loadAuthChoicePluginProvidersRuntime = createLazyRuntimeSurface(
  loadPluginProviderRuntime,
  ({ authChoicePluginProvidersRuntime }) => authChoicePluginProvidersRuntime,
);

function buildIsolatedProviderResolutionConfig(
  cfg: OpenClawConfig,
  ids: Iterable<string | undefined>,
): OpenClawConfig {
  const allow = new Set(cfg.plugins?.allow ?? []);
  const entries = {
    ...cfg.plugins?.entries,
  };
  let changed = false;
  for (const rawId of ids) {
    const id = rawId?.trim();
    if (!id) {
      continue;
    }
    allow.add(id);
    entries[id] = {
      ...cfg.plugins?.entries?.[id],
      enabled: true,
    };
    changed = true;
  }
  if (!changed) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: Array.from(allow),
      entries,
    },
  };
}

export async function applyNonInteractivePluginProviderChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: string;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  resolveApiKey: (input: ProviderResolveNonInteractiveApiKeyParams) => Promise<{
    key: string;
    source: "profile" | "env" | "flag";
    envVarName?: string;
  } | null>;
  toApiKeyCredential: (
    input: ProviderNonInteractiveApiKeyCredentialParams,
  ) => ApiKeyCredential | null;
}): Promise<OpenClawConfig | null | undefined> {
  const agentId = resolveDefaultAgentId(params.nextConfig);
  const agentDir = resolveAgentDir(params.nextConfig, agentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(params.nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const prefixedProviderId = params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)
    ? params.authChoice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length).split(":", 1)[0]?.trim()
    : undefined;
  const preferredProviderId =
    prefixedProviderId ||
    (await resolvePreferredProviderForAuthChoice({
      choice: params.authChoice,
      config: params.nextConfig,
      workspaceDir,
    }));
  const { resolveOwningPluginIdsForProvider, resolveProviderPluginChoice, resolvePluginProviders } =
    await loadAuthChoicePluginProvidersRuntime();
  const owningPluginIds = preferredProviderId
    ? resolveOwningPluginIdsForProvider({
        provider: preferredProviderId,
        config: params.nextConfig,
        workspaceDir,
      })
    : undefined;
  const resolutionConfig = buildIsolatedProviderResolutionConfig(params.nextConfig, [
    preferredProviderId,
    ...(owningPluginIds ?? []),
  ]);
  const providerChoice = resolveProviderPluginChoice({
    providers: resolvePluginProviders({
      config: resolutionConfig,
      workspaceDir,
      onlyPluginIds: owningPluginIds,
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
    }),
    choice: params.authChoice,
  });
  if (!providerChoice) {
    return undefined;
  }

  const enableResult = enablePluginInConfig(
    params.nextConfig,
    providerChoice.provider.pluginId ?? providerChoice.provider.id,
  );
  if (!enableResult.enabled) {
    params.runtime.error(
      `${providerChoice.provider.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
    );
    params.runtime.exit(1);
    return null;
  }

  const method = providerChoice.method;
  if (!method.runNonInteractive) {
    params.runtime.error(
      [
        `Auth choice "${params.authChoice}" requires interactive mode.`,
        `The ${providerChoice.provider.label} provider plugin does not implement non-interactive setup.`,
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }

  return method.runNonInteractive({
    authChoice: params.authChoice,
    config: enableResult.config,
    baseConfig: params.baseConfig,
    opts: params.opts as ProviderAuthOptionBag,
    runtime: params.runtime,
    agentDir,
    workspaceDir,
    resolveApiKey: params.resolveApiKey,
    toApiKeyCredential: params.toApiKeyCredential,
  });
}
