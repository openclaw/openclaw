import type { OpenClawConfig } from "../config/config.js";
import { resolveManifestProviderAuthChoice } from "./provider-auth-choices.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<string, string>> = {
  chutes: "chutes",
  "litellm-api-key": "litellm",
  "azure-openai-api-key": "azure-openai",
  "custom-api-key": "custom",
};

function normalizeLegacyAuthChoice(choice: string): string {
  if (choice === "oauth") {
    return "setup-token";
  }
  if (choice === "claude-cli") {
    return "setup-token";
  }
  if (choice === "codex-cli") {
    return "openai-codex";
  }
  return choice;
}

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const choice = normalizeLegacyAuthChoice(params.choice) ?? params.choice;
  const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
  if (manifestResolved) {
    return manifestResolved.providerId;
  }

  const { resolveProviderPluginChoice, resolvePluginProviders } =
    await import("./provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const pluginResolved = resolveProviderPluginChoice({
    providers,
    choice,
  });
  if (pluginResolved) {
    return pluginResolved.provider.id;
  }

  return PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
}
