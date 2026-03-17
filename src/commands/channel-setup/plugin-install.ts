import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "../onboarding/plugin-install.js";

export async function ensureChannelSetupPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
}): Promise<{ cfg: OpenClawConfig; installed: boolean; pluginId?: string }> {
  const result = await ensureOnboardingPluginInstalled(params);
  return {
    ...result,
    ...(params.entry.pluginId ? { pluginId: params.entry.pluginId } : {}),
  };
}

export function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: ChannelId;
  pluginId?: string;
  workspaceDir?: string;
}): {
  channels: Array<{
    pluginId: string;
    plugin: (typeof listChannelPlugins)[number];
    source: string;
  }>;
  channelSetups: Array<{
    pluginId: string;
    plugin: (typeof listChannelPlugins)[number];
    source: string;
  }>;
} {
  reloadOnboardingPluginRegistry({
    cfg: params.cfg,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
  });
  const channels = listChannelPlugins()
    .filter((plugin) => plugin.id === params.channel)
    .map((plugin) => ({
      pluginId: params.pluginId ?? String(plugin.id),
      plugin,
      source: "registry",
    }));
  return {
    channels,
    channelSetups: channels,
  };
}
