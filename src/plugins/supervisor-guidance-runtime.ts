import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
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
    const selected = config.plugins?.slots?.supervisorGuidance?.trim();
    if (!selected || selected === "none") {
      return undefined;
    }
    const id = normalizePluginId(selected);
    const plugins = normalizePluginsConfig(config.plugins);
    if (!plugins.enabled || plugins.entries[id]?.enabled === false || plugins.deny.includes(id)) {
      return undefined;
    }
    // The Gateway reuses its captured metadata generation; cold CLI consumers discover
    // manifests only after an operator has selected a guidance provider.
    const { loadPluginManifestRegistryCore } = await import("./manifest-registry.js");
    const { withArtifactPreservingStateReads } =
      await import("../state/openclaw-state-db-readonly.js");
    const registry = withArtifactPreservingStateReads(() =>
      loadPluginManifestRegistryCore({ config, env }),
    );
    const plugin = registry.plugins.find((entry) => entry.id === id);
    if (
      !plugin?.supervisorGuidance ||
      !resolveEffectivePluginActivationState({
        id,
        origin: plugin.origin,
        config: plugins,
        rootConfig: config,
        enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
        channelIds: plugin.channels,
      }).enabled
    ) {
      return undefined;
    }
    const pluginConfig = plugins.entries[id]?.config;
    const key = plugin.supervisorGuidance.configKey;
    const guidance = parseSupervisorGuidance(
      isRecord(pluginConfig) && Object.hasOwn(pluginConfig, key) ? pluginConfig[key] : undefined,
    );
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
