import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { AnyChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "./audit.types.js";

type PluginAuditContext = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  configPath: string;
  workspaceDir?: string;
  plugins?: AnyChannelPlugin[];
  loadPluginSecurityCollectors: boolean;
};

export async function collectPluginSecurityAuditFindings(
  context: PluginAuditContext,
): Promise<SecurityAuditFinding[]> {
  const { collectPluginConfigSecurityAuditFindings } = await import("./audit-plugin-config.js");
  const configFindings = await collectPluginConfigSecurityAuditFindings({
    config: context.cfg,
    sourceConfig: context.sourceConfig,
    env: context.env,
    stateDir: context.stateDir,
    configPath: context.configPath,
    workspaceDir: context.workspaceDir,
  });
  if (!context.loadPluginSecurityCollectors) {
    return configFindings;
  }
  const { getActivePluginRegistry } = await import("../plugins/runtime.js");
  let collectors = getActivePluginRegistry()?.securityAuditCollectors ?? [];
  if (collectors.length === 0) {
    const { applyPluginAutoEnable } = await import("../config/plugin-auto-enable.js");
    const autoEnabled = applyPluginAutoEnable({
      config: context.sourceConfig,
      env: context.env,
    });
    const requestedPluginIds = new Set(
      normalizeStringEntries([
        ...Object.keys(autoEnabled.autoEnabledReasons),
        ...(autoEnabled.config.plugins?.allow ?? []).filter((id) => typeof id === "string"),
        ...Object.entries(autoEnabled.config.plugins?.entries ?? {})
          .filter(([, entry]) => entry?.enabled !== false)
          .map(([id]) => id),
      ]),
    );
    if (context.plugins !== undefined) {
      const { resolveConfiguredChannelPluginIdsAsync } =
        await import("../plugins/channel-plugin-ids.js");
      const auditedChannelPluginIds = new Set(context.plugins.map((plugin) => plugin.id));
      for (const pluginId of await resolveConfiguredChannelPluginIdsAsync({
        config: autoEnabled.config,
        activationSourceConfig: context.sourceConfig,
        workspaceDir: context.workspaceDir,
        env: context.env,
      })) {
        if (auditedChannelPluginIds.has(pluginId)) {
          requestedPluginIds.delete(pluginId);
        }
      }
    }
    if (requestedPluginIds.size === 0) {
      return configFindings;
    }
    const snapshot = (
      await import("../plugins/runtime/metadata-registry-loader.js")
    ).loadPluginMetadataRegistrySnapshot({
      config: autoEnabled.config,
      activationSourceConfig: context.sourceConfig,
      env: context.env,
      workspaceDir: context.workspaceDir,
      onlyPluginIds: [...requestedPluginIds],
    });
    collectors = snapshot.securityAuditCollectors ?? [];
  }
  const collectorResults = await Promise.all(
    collectors.map(async (entry) => {
      try {
        return await entry.collector({
          config: context.cfg,
          sourceConfig: context.sourceConfig,
          env: context.env,
          stateDir: context.stateDir,
          configPath: context.configPath,
        });
      } catch (err) {
        return [
          {
            checkId: `plugins.${entry.pluginId}.security_audit_failed`,
            severity: "warn" as const,
            title: "Plugin security audit collector failed",
            detail: `${entry.pluginId}: ${String(err)}`,
          },
        ];
      }
    }),
  );
  return [...configFindings, ...collectorResults.flat()];
}
