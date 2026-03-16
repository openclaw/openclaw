import type { OpenClawConfig } from "../config/config.js";
import { resolveManifestProviderAuthChoice } from "../plugins/provider-auth-choices.js";
import { normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import type { AuthChoice } from "./onboard-types.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  chutes: "chutes",
  "litellm-api-key": "litellm",
  "custom-api-key": "custom",
};

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: AuthChoice;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const choice = normalizeLegacyOnboardAuthChoice(params.choice) ?? params.choice;
  const manifestResolved = resolveManifestProviderAuthChoice(choice, params);
  if (manifestResolved) {
    return manifestResolved.providerId;
  }
  const [{ resolveProviderPluginChoice }, { resolvePluginProviders }] = await Promise.all([
    import("../plugins/provider-wizard.js"),
    import("../plugins/providers.js"),
  ]);
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

  const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
  if (preferred) {
    return preferred;
  }
  return undefined;
}
