import type { PluginManifestSetup } from "../plugins/manifest.js";
import { resolveLocalProviderAuthEvidence } from "../secrets/provider-auth-evidence.js";
import type { TemplateLocalPrerequisite } from "./types.js";

export function resolveTemplatePluginSetupRequirements(params: {
  pluginId: string;
  setup?: PluginManifestSetup;
  env: NodeJS.ProcessEnv;
}): TemplateLocalPrerequisite[] {
  const providers = params.setup?.providers ?? [];
  const hasConfiguredProvider = providers.some(
    (provider) =>
      (provider.envVars ?? []).some((name) => Boolean(params.env[name]?.trim())) ||
      resolveLocalProviderAuthEvidence(provider.authEvidence, params.env),
  );
  if (hasConfiguredProvider) {
    return [];
  }
  return providers.flatMap((provider) => {
    const envVars = provider.envVars ?? [];
    const authEvidence = provider.authEvidence ?? [];
    if (envVars.length === 0 && authEvidence.length === 0) {
      return [];
    }
    return [
      {
        kind: "plugin-setup" as const,
        plugin: params.pluginId,
        provider: provider.id,
        envVars,
        authMethods: provider.authMethods ?? [],
      },
    ];
  });
}
