import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  parseSupervisorGuidance,
  type SupervisorAction,
  type SupervisorDisplayGuidance,
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
    const candidates = new Set(
      Object.entries(plugins.entries)
        .filter(
          ([id, entry]) =>
            entry.enabled !== false && !plugins.deny.includes(id) && isRecord(entry.config),
        )
        .map(([id]) => id),
    );
    if (!plugins.enabled || candidates.size === 0) {
      return undefined;
    }
    // The Gateway reuses captured metadata; cold CLI consumers discover manifests
    // only when an operator has configured a potentially eligible plugin.
    const { loadPluginManifestRegistryCore } = await import("./manifest-registry.js");
    const { withArtifactPreservingStateReads } =
      await import("../state/openclaw-state-db-readonly.js");
    const registry = withArtifactPreservingStateReads(() =>
      loadPluginManifestRegistryCore({ config, env }),
    );
    let guidance: ReturnType<typeof parseSupervisorGuidance>;
    for (const plugin of registry.plugins) {
      if (
        !candidates.has(plugin.id) ||
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
      const pluginConfig = plugins.entries[plugin.id]?.config;
      const key = plugin.supervisorGuidance.configKey;
      const configured = parseSupervisorGuidance(
        isRecord(pluginConfig) && Object.hasOwn(pluginConfig, key) ? pluginConfig[key] : undefined,
      );
      if (!configured) {
        continue;
      }
      // Resolve one owner before choosing an action so conflicting providers cannot
      // silently split lifecycle instructions between different supervisors.
      if (guidance) {
        return undefined;
      }
      guidance = configured;
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
