// Channel inbound root helpers resolve media roots for channel-delivered files.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { resolveManifestOwnerBasePolicyBlock } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
// Metadata reads stay behind the registration bridge so media root resolution
// never pulls the control-plane/kysely graph into light call paths.
import { getCurrentPluginMetadataSnapshotRuntime } from "../plugins/plugin-metadata-snapshot.runtime.js";
import {
  loadBundledPluginPublicArtifactModuleSync,
  loadPluginPublicArtifactModuleSync,
} from "../plugins/public-surface-loader.js";

const CHANNEL_MEDIA_CONTRACT_ARTIFACT = "media-contract-api.js";

type ChannelMediaContractApi = {
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
};
type ChannelMediaRootResolver = keyof ChannelMediaContractApi;

function acceptsResolver(
  loaded: ChannelMediaContractApi,
  resolver: ChannelMediaRootResolver,
): boolean {
  return typeof loaded[resolver] === "function";
}

function loadBundledChannelMediaContractApi(
  channelId: string,
  resolver: ChannelMediaRootResolver,
): ChannelMediaContractApi | undefined {
  try {
    // Media-root resolution must stay a narrow artifact load, not full channel bootstrap.
    const loaded = loadBundledPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
      dirName: channelId,
      artifactBasename: CHANNEL_MEDIA_CONTRACT_ARTIFACT,
    });
    return acceptsResolver(loaded, resolver) ? loaded : undefined;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      )
    ) {
      throw error;
    }
  }

  return undefined;
}

function declaresChannel(plugin: PluginManifestRecord, channelId: string): boolean {
  return plugin.channels.some(
    (ownedChannelId) => normalizeOptionalLowercaseString(ownedChannelId) === channelId,
  );
}

type ChannelMediaContractOwner = Pick<PluginManifestRecord, "id" | "rootDir">;

/**
 * Lists installed official channel plugins that may own a channel's media contract.
 *
 * Bundled owners are resolved from the bundled plugin surface; workspace and
 * community installs never gain attachment-root authority, so only
 * host-verified official npm installs qualify. Current operator policy still
 * wins over install provenance: denylisted, explicitly disabled, and
 * out-of-allowlist plugins lose attachment-root authority before their artifact
 * executes or supplies file-access roots.
 */
function listTrustedInstalledChannelMediaContractOwners(params: {
  channelId: string;
  cfg: OpenClawConfig;
  plugins: readonly PluginManifestRecord[];
}): ChannelMediaContractOwner[] {
  const channelId = normalizeOptionalLowercaseString(params.channelId);
  if (!channelId) {
    return [];
  }
  const normalizedConfig = normalizePluginsConfig(params.cfg.plugins);
  return params.plugins
    .filter(
      (plugin) =>
        plugin.origin === "global" &&
        plugin.trustedOfficialInstall === true &&
        declaresChannel(plugin, channelId) &&
        resolveManifestOwnerBasePolicyBlock({ plugin, normalizedConfig }) === null,
    )
    .map((plugin) => ({ id: plugin.id, rootDir: plugin.rootDir }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function resolveInstalledChannelMediaContractOwners(params: {
  channelId: string;
  cfg: OpenClawConfig;
}): ChannelMediaContractOwner[] {
  try {
    // Read the current plugin metadata generation only. Attachment-root
    // resolution must never start plugin discovery or index work of its own.
    const snapshot = getCurrentPluginMetadataSnapshotRuntime({
      config: params.cfg,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    });
    if (!snapshot) {
      return [];
    }
    return listTrustedInstalledChannelMediaContractOwners({
      channelId: params.channelId,
      cfg: params.cfg,
      plugins: snapshot.manifestRegistry.plugins,
    });
  } catch {
    // Snapshot reads must never turn a missing channel artifact into a hard failure.
    return [];
  }
}

function loadInstalledChannelMediaContractApi(params: {
  channelId: string;
  cfg: OpenClawConfig;
  resolver: ChannelMediaRootResolver;
}): ChannelMediaContractApi | undefined {
  for (const owner of resolveInstalledChannelMediaContractOwners({
    channelId: params.channelId,
    cfg: params.cfg,
  })) {
    try {
      const loaded = loadPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
        pluginRoot: owner.rootDir,
        artifactBasename: CHANNEL_MEDIA_CONTRACT_ARTIFACT,
        origin: "global",
      });
      if (acceptsResolver(loaded, params.resolver)) {
        return loaded;
      }
    } catch (error) {
      if (error instanceof MissingPublicSurfaceError) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

function loadChannelMediaContractApi(params: {
  channelId: string;
  cfg: OpenClawConfig;
  resolver: ChannelMediaRootResolver;
}): ChannelMediaContractApi | undefined {
  return (
    loadBundledChannelMediaContractApi(params.channelId, params.resolver) ??
    // External official channel packages ship outside the core bundle, so the
    // installed plugin root is the only place their media contract can live.
    loadInstalledChannelMediaContractApi(params)
  );
}

function findChannelMediaContractApi(params: {
  channelId: string | null | undefined;
  cfg: OpenClawConfig;
  resolver: ChannelMediaRootResolver;
}) {
  const normalized = normalizeOptionalLowercaseString(params.channelId);
  if (!normalized) {
    return undefined;
  }
  return loadChannelMediaContractApi({
    channelId: normalized,
    cfg: params.cfg,
    resolver: params.resolver,
  });
}

/** Resolves local inbound attachment roots from the channel named in a message context. */
export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  return resolveChannelInboundAttachmentRootsForChannel({
    cfg: params.cfg,
    channelId: params.ctx.Surface ?? params.ctx.Provider,
    accountId: params.ctx.AccountId,
  });
}

/** Resolves local inbound attachment roots for callers that already know the channel id. */
export function resolveChannelInboundAttachmentRootsForChannel(params: {
  cfg: OpenClawConfig;
  channelId?: string | null;
  accountId?: string | null;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi({
    channelId: params.channelId,
    cfg: params.cfg,
    resolver: "resolveInboundAttachmentRoots",
  });
  if (contractApi?.resolveInboundAttachmentRoots) {
    return contractApi.resolveInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
  }
  return undefined;
}

/** Resolves remote staging roots for inbound channel attachments without loading full channel code. */
export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi({
    channelId: params.ctx.Surface ?? params.ctx.Provider,
    cfg: params.cfg,
    resolver: "resolveRemoteInboundAttachmentRoots",
  });
  if (contractApi?.resolveRemoteInboundAttachmentRoots) {
    return contractApi.resolveRemoteInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
    });
  }
  return undefined;
}
