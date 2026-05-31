import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
  type OnboardingPluginInstallStatus,
} from "../onboarding-plugin-install.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";

type InstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId?: string;
  status: OnboardingPluginInstallStatus;
};

function toOnboardingPluginInstallEntry(
  entry: ChannelPluginCatalogEntry,
): OnboardingPluginInstallEntry {
  return {
    pluginId: entry.pluginId ?? entry.id,
    label: entry.meta.label,
    install: entry.install,
    ...(entry.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
  };
}

/** Installs the plugin behind a channel setup catalog entry using the shared onboarding installer. */
export async function ensureChannelSetupPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
  autoConfirmSingleSource?: boolean;
}): Promise<InstallResult> {
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: toOnboardingPluginInstallEntry(params.entry),
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    ...(params.promptInstall !== undefined ? { promptInstall: params.promptInstall } : {}),
    ...(params.autoConfirmSingleSource !== undefined
      ? { autoConfirmSingleSource: params.autoConfirmSingleSource }
      : {}),
  });
  return {
    cfg: result.cfg,
    installed: result.installed,
    pluginId: result.pluginId,
    status: result.status,
  };
}

/** Reloads channel setup plugins from config so newly installed setup wizards become available. */
export function reloadChannelSetupPluginRegistry(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): void {
  loadChannelSetupPluginRegistry(params);
}

function loadChannelSetupPluginRegistry(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  activate?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
}): PluginRegistry {
  const autoEnabled = applyPluginAutoEnable({ config: params.cfg, env: process.env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const onlyPluginIds =
    params.onlyPluginIds ??
    resolveConfiguredChannelPluginIds({
      config: resolvedConfig,
      activationSourceConfig: params.cfg,
      workspaceDir,
      env: process.env,
    });
  const log = createSubsystemLogger("plugins");
  // Setup commands need a fresh registry snapshot because plugin installation
  // can change config moments before this loader runs.
  return loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    cache: false,
    logger: createPluginLoaderLogger(log),
    onlyPluginIds,
    includeSetupOnlyChannelPlugins: true,
    forceSetupOnlyChannelPlugins: params.forceSetupOnlyChannelPlugins,
    activate: params.activate,
  });
}

function resolveScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): string | undefined {
  const explicitPluginId = params.pluginId?.trim();
  if (explicitPluginId) {
    return explicitPluginId;
  }
  // Prefer trusted catalog plugin ids; manifest discovery is a fallback only when exactly one plugin owns the channel.
  return (
    getTrustedChannelPluginCatalogEntry(params.channel, {
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.pluginId ?? resolveUniqueManifestScopedChannelPluginId(params)
  );
}

function resolveUniqueManifestScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  workspaceDir?: string;
}): string | undefined {
  // Multiple discoverable owners means setup must load the normal configured
  // set instead of guessing which plugin should answer for the channel.
  const matches = resolveDiscoverableScopedChannelPluginIds({
    config: params.cfg,
    channelIds: [params.channel],
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Reloads the registry for a single channel, narrowing activation when a unique plugin owner is known. */
export function reloadChannelSetupPluginRegistryForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): void {
  const scopedPluginId = resolveScopedChannelPluginId({
    cfg: params.cfg,
    channel: params.channel,
    pluginId: params.pluginId,
    workspaceDir: params.workspaceDir,
  });
  loadChannelSetupPluginRegistry({
    ...params,
    ...(scopedPluginId ? { onlyPluginIds: [scopedPluginId] } : {}),
  });
}

/** Loads an inactive setup registry snapshot for one channel so setup status can be inspected without activation. */
export function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
  forceSetupOnlyChannelPlugins?: boolean;
}): PluginRegistry {
  const scopedPluginId = resolveScopedChannelPluginId({
    cfg: params.cfg,
    channel: params.channel,
    pluginId: params.pluginId,
    workspaceDir: params.workspaceDir,
  });
  return loadChannelSetupPluginRegistry({
    ...params,
    ...(scopedPluginId ? { onlyPluginIds: [scopedPluginId] } : {}),
    activate: false,
  });
}
