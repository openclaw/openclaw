import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatChannels } from "../../channels/chat-meta.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { isChannelVisibleInSetup } from "../../channels/plugins/exposure.js";
import { normalizeChannelMeta } from "../../channels/plugins/meta-normalization.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../../channels/plugins/types.public.js";
import { isStaticallyChannelConfigured } from "../../config/channel-configured-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelChoice } from "../onboard-types.js";
import {
  listManifestInstalledChannelIds,
  listSetupDiscoveryChannelPluginCatalogEntries,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

export function shouldShowChannelInSetup(meta: Pick<ChannelMeta, "exposure">): boolean {
  return isChannelVisibleInSetup(meta);
}

function resolveWorkspaceDir(cfg: OpenClawConfig, workspaceDir?: string): string | undefined {
  return workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

/** Return true when a trusted catalog channel is already installed through plugin manifests. */
export function isCatalogChannelInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  workspaceDir?: string;
}): boolean {
  return listManifestInstalledChannelIds(params).has(params.entry.id as ChannelChoice);
}

/** Merge configured channels and installable catalog channels into setup display buckets. */
export function resolveChannelSetupEntries(params: {
  cfg: OpenClawConfig;
  installedPlugins: ChannelPlugin[];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const workspaceDir = resolveWorkspaceDir(params.cfg, params.workspaceDir);
  const manifestInstalledIds = listManifestInstalledChannelIds({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const installedPluginIds = new Set(params.installedPlugins.map((plugin) => plugin.id));
  // Discovery keeps workspace-only install candidates visible, while the
  // installed bucket must still reflect what setup can safely auto-load.
  const installedCatalogEntriesSource = listTrustedChannelPluginCatalogEntries({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const installableCatalogEntriesSource = listSetupDiscoveryChannelPluginCatalogEntries({
    cfg: params.cfg,
    workspaceDir,
    env: params.env,
  });
  const catalogEntries = (entries: ChannelPluginCatalogEntry[], installed: boolean) =>
    entries
      .filter(
        (entry) =>
          !installedPluginIds.has(entry.id) &&
          manifestInstalledIds.has(entry.id as ChannelChoice) === installed &&
          (installed ||
            !isStaticallyChannelConfigured(params.cfg, entry.id, params.env ?? process.env)) &&
          shouldShowChannelInSetup(entry.meta),
      )
      .map((entry) =>
        Object.assign({}, entry, {
          meta: normalizeChannelMeta({ id: entry.id as ChannelChoice, meta: entry.meta }),
        }),
      );
  const installedCatalogEntries = catalogEntries(installedCatalogEntriesSource, true);
  const installableCatalogEntries = catalogEntries(installableCatalogEntriesSource, false);

  const metaById = new Map<string, ChannelMeta>(
    listChatChannels().map((meta) => [meta.id, normalizeChannelMeta({ id: meta.id, meta })]),
  );
  for (const plugin of params.installedPlugins) {
    metaById.set(
      plugin.id,
      normalizeChannelMeta({
        id: plugin.id,
        meta: plugin.meta,
        existing: metaById.get(plugin.id),
      }),
    );
  }
  for (const entry of [...installedCatalogEntries, ...installableCatalogEntries]) {
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
