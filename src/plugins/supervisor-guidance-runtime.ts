import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type {
  SupervisorAction,
  SupervisorDisplayGuidance,
  SupervisorGuidanceV1,
} from "./supervisor-guidance.js";

/** Resolve display data without activating plugin code or granting lifecycle authority. */
export async function resolveExternalSupervisorGuidance(
  action: SupervisorAction,
  options: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {},
): Promise<SupervisorDisplayGuidance | undefined> {
  const env = options.env ?? process.env;
  if (!isGatewayExternallySupervised(env)) {
    return undefined;
  }
  try {
    const config = options.config ?? (await readGuidanceConfig(env));
    const plugins = normalizePluginsConfig(config.plugins);
    if (!plugins.enabled) {
      return undefined;
    }
    // Reuse captured metadata without importing the package's runtime code.
    const { loadPluginManifestRegistryCore } = await import("./manifest-registry.js");
    const { withArtifactPreservingStateReads } =
      await import("../state/openclaw-state-db-readonly.js");
    const registry = withArtifactPreservingStateReads(() =>
      loadPluginManifestRegistryCore({ config, env }),
    );
    let guidance: SupervisorGuidanceV1 | undefined;
    for (const plugin of registry.plugins) {
      if (
        !plugin.supervisorGuidance ||
        !resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          config: plugins,
          rootConfig: config,
          enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
          channelIds: plugin.channels,
        }).enabled
      ) {
        continue;
      }
      // Resolve one owner before choosing an action so conflicting providers cannot
      // silently split lifecycle instructions between different supervisors.
      if (guidance) {
        return undefined;
      }
      guidance = plugin.supervisorGuidance;
    }
    const command = guidance?.actions[action];
    if (!guidance || !command || !isGatewayExternallySupervised(env)) {
      return undefined;
    }
    return {
      version: 1,
      action,
      name: guidance.name,
      ...(guidance.runFrom ? { runFrom: guidance.runFrom } : {}),
      command,
    };
  } catch {
    // Recovery must retain the original refusal when config or plugin discovery is
    // unavailable. Never include rejected guidance contents in an error or log.
    return undefined;
  }
}

async function readGuidanceConfig(env: NodeJS.ProcessEnv): Promise<OpenClawConfig> {
  const { createConfigIO, getRuntimeConfigSnapshot } = await import("../config/config.js");
  return (
    (env === process.env ? getRuntimeConfigSnapshot() : null) ??
    (await createConfigIO({ env }).readBestEffortConfig())
  );
}
