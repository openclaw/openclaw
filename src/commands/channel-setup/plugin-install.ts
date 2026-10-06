import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ensureOnboardingPluginInstalled } from "../onboarding-plugin-install.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";

type OnboardingInstallResult = Awaited<ReturnType<typeof ensureOnboardingPluginInstalled>>;

/** Install or reuse the plugin package required by a trusted channel catalog entry. */
export async function ensureChannelSetupPluginInstalled(
  params: Omit<
    Parameters<typeof ensureOnboardingPluginInstalled>[0],
    "entry" | "onCapabilityConsent" | "beforePersistentEffect"
  > & {
    entry: ChannelPluginCatalogEntry;
    beforePersistentEffect?: () => Promise<void>;
  },
): Promise<
  Pick<OnboardingInstallResult, "cfg" | "installed" | "status"> &
    Partial<Pick<OnboardingInstallResult, "pluginId">>
> {
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: {
      pluginId: params.entry.pluginId ?? params.entry.id,
      label: params.entry.meta.label,
      install: params.entry.install,
      ...(params.entry.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
    },
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    ...(params.promptInstall !== undefined ? { promptInstall: params.promptInstall } : {}),
    ...(params.autoConfirmSingleSource !== undefined
      ? { autoConfirmSingleSource: params.autoConfirmSingleSource }
      : {}),
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });
  return {
    cfg: result.cfg,
    installed: result.installed,
    pluginId: result.pluginId,
    status: result.status,
  };
}

/** Load an inactive setup-plugin registry snapshot for resolving a channel without side effects. */
export function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
  forceSetupOnlyChannelPlugins?: boolean;
}): PluginRegistry {
  let scopedPluginId = params.pluginId?.trim();
  if (!scopedPluginId) {
    scopedPluginId = getTrustedChannelPluginCatalogEntry(params.channel, {
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.pluginId;
    if (scopedPluginId == null) {
      const matches = resolveDiscoverableScopedChannelPluginIds({
        config: params.cfg,
        channelIds: [params.channel],
        workspaceDir: params.workspaceDir,
        env: process.env,
      });
      scopedPluginId = matches.length === 1 ? matches[0] : undefined;
    }
  }
  const autoEnabled = applyPluginAutoEnable({ config: params.cfg, env: process.env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const onlyPluginIds = scopedPluginId
    ? [scopedPluginId]
    : resolveConfiguredChannelPluginIds({
        config: resolvedConfig,
        activationSourceConfig: params.cfg,
        workspaceDir,
        env: process.env,
      });
  const log = createSubsystemLogger("plugins");
  return loadPluginRegistryHandle({
    config: resolvedConfig,
    activationSourceConfig: params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    cache: false,
    logger: log,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins: true,
    forceSetupOnlyChannelPlugins: params.forceSetupOnlyChannelPlugins,
    channelPluginLoadIntent: "setup",
  });
}
