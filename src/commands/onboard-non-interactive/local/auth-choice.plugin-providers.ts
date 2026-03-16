import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { enablePluginInConfig } from "../../../plugins/enable.js";
import type {
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolvePreferredProviderForAuthChoice } from "../../auth-choice.preferred-provider.js";
import type { OnboardOptions } from "../../onboard-types.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

async function loadPluginProviderRuntime() {
  return import("./auth-choice.plugin-providers.runtime.js");
}

function buildIsolatedProviderResolutionConfig(
  cfg: OpenClawConfig,
  providerId: string | undefined,
): OpenClawConfig {
  if (!providerId) {
    return cfg;
  }
  const allow = new Set(cfg.plugins?.allow ?? []);
  allow.add(providerId);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: Array.from(allow),
      entries: {
        ...cfg.plugins?.entries,
        [providerId]: {
          ...cfg.plugins?.entries?.[providerId],
          enabled: true,
        },
      },
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
  const resolutionConfig = buildIsolatedProviderResolutionConfig(
    params.nextConfig,
    preferredProviderId,
  );
  const { resolveOwningPluginIdsForProvider, resolveProviderPluginChoice, resolvePluginProviders } =
    await loadPluginProviderRuntime();
  const owningPluginIds = preferredProviderId
    ? resolveOwningPluginIdsForProvider({
        provider: preferredProviderId,
        config: resolutionConfig,
        workspaceDir,
      })
    : undefined;
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
    opts: params.opts,
    runtime: params.runtime,
    agentDir,
    workspaceDir,
    resolveApiKey: params.resolveApiKey,
    toApiKeyCredential: params.toApiKeyCredential,
  });
}
