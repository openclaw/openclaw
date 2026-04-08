import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { isChannelVisibleInSetup } from "../../channels/plugins/exposure.js";
import type { ChannelMeta, ChannelPlugin } from "../../channels/plugins/types.js";
import { listChatChannels } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { ChannelChoice } from "../onboard-types.js";
import {
  isTrustedWorkspaceChannelCatalogEntry,
  isTrustedWorkspacePlugin,
} from "./workspace-trust.js";

type ChannelCatalogEntry = {
  id: ChannelChoice;
  meta: ChannelMeta;
};

export function shouldShowChannelInSetup(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return isChannelVisibleInSetup(meta);
}

export type ResolvedChannelSetupEntries = {
  entries: ChannelCatalogEntry[];
  installedCatalogEntries: ChannelPluginCatalogEntry[];
  installableCatalogEntries: ChannelPluginCatalogEntry[];
  installedCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
  installableCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
};

function resolveWorkspaceDir(cfg: OpenClawConfig, workspaceDir?: string): string | undefined {
  return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

export function listManifestInstalledChannelIds(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Set<ChannelChoice> {
  const resolvedConfig = applyPluginAutoEnable({
    config: params.cfg,
    env: params.env ?? process.env,
  }).config;
  const workspaceDir = resolveWorkspaceDir(resolvedConfig, params.workspaceDir);
  return new Set(
    loadPluginManifestRegistry({
      config: resolvedConfig,
      workspaceDir,
      env: params.env ?? process.env,
    }).plugins.flatMap((plugin) =>
      isTrustedWorkspacePlugin({
        pluginId: plugin.id,
        origin: plugin.origin,
        cfg: resolvedConfig,
      })
        ? (plugin.channels as ChannelChoice[])
        : [],
    ),
  );
}

export function isCatalogChannelInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return listManifestInstalledChannelIds(params).has(params.entry.id as ChannelChoice);
}

export function resolveChannelSetupEntries(params: {
  cfg: OpenClawConfig;
  installedPlugins: ChannelPlugin[];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedChannelSetupEntries {
  const resolvedConfig = applyPluginAutoEnable({
    config: params.cfg,
    env: params.env ?? process.env,
  }).config;
  const workspaceDir = resolveWorkspaceDir(resolvedConfig, params.workspaceDir);
  const manifestInstalledIds = listManifestInstalledChannelIds({
    cfg: resolvedConfig,
    workspaceDir,
    env: params.env,
  });
  const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
  const catalogEntries = listChannelPluginCatalogEntries({ workspaceDir });
  const nonWorkspaceCatalogEntries = listChannelPluginCatalogEntries({
    workspaceDir,
    excludeWorkspace: true,
  });
  const nonWorkspaceCatalogById = new Map(
    nonWorkspaceCatalogEntries.map((entry) => [entry.id, entry]),
  );
  // Build installed entries from the full catalog so trusted workspace entries are included.
  // When a workspace shadow is present but untrusted, fall back to the non-workspace entry
  // for that channel so an already-installed non-workspace channel is not silently dropped.
  const installedCatalogEntries: ChannelPluginCatalogEntry[] = [];
  for (const entry of catalogEntries) {
    if (
      installedPluginIds.has(entry.id) ||
      !manifestInstalledIds.has(entry.id as ChannelChoice) ||
      !shouldShowChannelInSetup(entry.meta)
    ) {
      continue;
    }
    if (isTrustedWorkspaceChannelCatalogEntry(entry, resolvedConfig)) {
      installedCatalogEntries.push(entry);
    } else {
      // Untrusted workspace shadow: use the non-workspace entry so the installed channel
      // remains visible in setup instead of disappearing behind the shadow.
      const fallback = nonWorkspaceCatalogById.get(entry.id);
      if (fallback && shouldShowChannelInSetup(fallback.meta)) {
        installedCatalogEntries.push(fallback);
      }
    }
  }
  const setupInstalledCatalogIds = new Set(
    installedCatalogEntries.map((entry) => entry.id as ChannelChoice),
  );
  const installableCatalogEntries = nonWorkspaceCatalogEntries.filter(
    (entry) =>
      !installedPluginIds.has(entry.id) &&
      !setupInstalledCatalogIds.has(entry.id as ChannelChoice) &&
      shouldShowChannelInSetup(entry.meta),
  );

  const metaById = new Map<string, ChannelMeta>();
  for (const meta of listChatChannels()) {
    metaById.set(meta.id, meta);
  }
  for (const plugin of params.installedPlugins) {
    metaById.set(plugin.id, plugin.meta);
  }
  for (const entry of installedCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(entry.id, entry.meta);
    }
  }
  for (const entry of installableCatalogEntries) {
    if (!metaById.has(entry.id)) {
      metaById.set(entry.id, entry.meta);
    }
  }

  return {
    entries: Array.from(metaById, ([id, meta]) => ({
      id: id as ChannelChoice,
      meta,
    })).filter((entry) => shouldShowChannelInSetup(entry.meta)),
    installedCatalogEntries,
    installableCatalogEntries,
    installedCatalogById: new Map(
      installedCatalogEntries.map((entry) => [entry.id as ChannelChoice, entry]),
    ),
    installableCatalogById: new Map(
      installableCatalogEntries.map((entry) => [entry.id as ChannelChoice, entry]),
    ),
  };
}
