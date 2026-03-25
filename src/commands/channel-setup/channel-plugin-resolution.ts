import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";

type ChannelPluginSnapshot = {
  channels: Array<{ plugin: ChannelPlugin }>;
  channelSetups: Array<{ plugin: ChannelPlugin }>;
};

type ResolveInstallableChannelPluginResult = {
  cfg: OpenClawConfig;
  channelId?: ChannelId;
  plugin?: ChannelPlugin;
  catalogEntry?: ChannelPluginCatalogEntry;
  configChanged: boolean;
  installDeclined: boolean;
};

function resolveWorkspaceDir(cfg: OpenClawConfig) {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function resolveManifestInstalledChannel(params: {
  cfg: OpenClawConfig;
  rawChannel?: string | null;
  channelId?: ChannelId;
}): { channelId: ChannelId; pluginId: string } | undefined {
  const requested =
    params.channelId ??
    (typeof params.rawChannel === "string" && params.rawChannel.trim()
      ? (params.rawChannel.trim().toLowerCase() as ChannelId)
      : undefined);
  if (!requested) {
    return undefined;
  }
  let match;
  try {
    match = loadPluginManifestRegistry({
      config: params.cfg,
      workspaceDir: resolveWorkspaceDir(params.cfg),
      env: process.env,
    }).plugins.find((plugin) =>
      plugin.channels.some((channel) => channel.trim().toLowerCase() === requested),
    );
  } catch {
    return undefined;
  }
  if (!match) {
    return undefined;
  }
  return {
    channelId: requested,
    pluginId: match.id,
  };
}

function resolveResolvedChannelId(params: {
  rawChannel?: string | null;
  catalogEntry?: ChannelPluginCatalogEntry;
}): ChannelId | undefined {
  const normalized = normalizeChannelId(params.rawChannel);
  if (normalized) {
    return normalized;
  }
  if (!params.catalogEntry) {
    return undefined;
  }
  return normalizeChannelId(params.catalogEntry.id) ?? (params.catalogEntry.id as ChannelId);
}

export function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  const workspaceDir = cfg ? resolveWorkspaceDir(cfg) : undefined;
  return listChannelPluginCatalogEntries({ workspaceDir }).find((entry) => {
    if (entry.id.toLowerCase() === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === trimmed);
  });
}

function findScopedChannelPlugin(
  snapshot: ChannelPluginSnapshot,
  channelId: ChannelId,
): ChannelPlugin | undefined {
  return (
    snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
    snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin
  );
}

function loadScopedChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channelId: ChannelId;
  pluginId?: string;
  workspaceDir?: string;
}): ChannelPlugin | undefined {
  const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
    cfg: params.cfg,
    runtime: params.runtime,
    channel: params.channelId,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    workspaceDir: params.workspaceDir,
  });
  return findScopedChannelPlugin(snapshot, params.channelId);
}

export async function resolveInstallableChannelPlugin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  rawChannel?: string | null;
  channelId?: ChannelId;
  allowInstall?: boolean;
  prompter?: WizardPrompter;
  supports?: (plugin: ChannelPlugin) => boolean;
}): Promise<ResolveInstallableChannelPluginResult> {
  const supports = params.supports ?? (() => true);
  let nextCfg = params.cfg;
  const workspaceDir = resolveWorkspaceDir(nextCfg);
  const catalogEntry =
    (params.rawChannel ? resolveCatalogChannelEntry(params.rawChannel, nextCfg) : undefined) ??
    (params.channelId
      ? getChannelPluginCatalogEntry(params.channelId, {
          workspaceDir,
        })
      : undefined);
  let channelId =
    params.channelId ??
    resolveResolvedChannelId({
      rawChannel: params.rawChannel,
      catalogEntry,
    });
  let manifestInstalled: ReturnType<typeof resolveManifestInstalledChannel>;
  if (!channelId) {
    manifestInstalled = resolveManifestInstalledChannel({
      cfg: nextCfg,
      rawChannel: params.rawChannel,
    });
    channelId = manifestInstalled?.channelId;
  }
  if (!channelId) {
    return {
      cfg: nextCfg,
      catalogEntry,
      configChanged: false,
      installDeclined: false,
    };
  }

  manifestInstalled ??= resolveManifestInstalledChannel({ cfg: nextCfg, channelId });

  const existing = getChannelPlugin(channelId);
  if (existing && supports(existing)) {
    return {
      cfg: nextCfg,
      channelId,
      plugin: existing,
      catalogEntry,
      configChanged: false,
      installDeclined: false,
    };
  }

  const resolvedPluginId = manifestInstalled?.pluginId ?? catalogEntry?.pluginId;
  if (resolvedPluginId ?? catalogEntry) {
    const scoped = loadScopedChannelPlugin({
      cfg: nextCfg,
      runtime: params.runtime,
      channelId,
      pluginId: resolvedPluginId,
      workspaceDir,
    });
    if (scoped && supports(scoped)) {
      return {
        cfg: nextCfg,
        channelId,
        plugin: scoped,
        catalogEntry,
        configChanged: false,
        installDeclined: false,
      };
    }
  }

  if (catalogEntry) {
    if (params.allowInstall !== false) {
      const installResult = await ensureChannelSetupPluginInstalled({
        cfg: nextCfg,
        entry: catalogEntry,
        prompter: params.prompter ?? createClackPrompter(),
        runtime: params.runtime,
        workspaceDir,
      });
      nextCfg = installResult.cfg;
      const installedPluginId = installResult.pluginId ?? resolvedPluginId;
      const installedPlugin = installResult.installed
        ? loadScopedChannelPlugin({
            cfg: nextCfg,
            runtime: params.runtime,
            channelId,
            pluginId: installedPluginId,
            workspaceDir: resolveWorkspaceDir(nextCfg),
          })
        : undefined;
      return {
        cfg: nextCfg,
        channelId,
        plugin: installedPlugin ?? existing,
        catalogEntry:
          installedPluginId && catalogEntry.pluginId !== installedPluginId
            ? { ...catalogEntry, pluginId: installedPluginId }
            : catalogEntry,
        configChanged: nextCfg !== params.cfg,
        installDeclined: !installResult.installed,
      };
    }
  }

  return {
    cfg: nextCfg,
    channelId,
    plugin: existing,
    catalogEntry,
    configChanged: false,
    installDeclined: false,
  };
}
