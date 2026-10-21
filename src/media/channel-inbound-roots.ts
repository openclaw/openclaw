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
  loadBundledPluginPublicArtifactModuleFromCandidatesSync,
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

function resolveInstalledChannelMediaContractOwners(params: {
  channelId: string;
  cfg: OpenClawConfig;
}): PluginManifestRecord[] {
  try {
    // Read the current plugin metadata generation only. Attachment-root
    // resolution must never start plugin discovery or index work of its own.
    const snapshot = getCurrentPluginMetadataSnapshotRuntime({
      config: params.cfg,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    });
    const normalizedConfig = normalizePluginsConfig(params.cfg.plugins);
    // Only operator-enabled official npm installs may grant attachment-root authority.
    return (snapshot?.manifestRegistry.plugins ?? [])
      .filter(
        (plugin) =>
          plugin.origin === "global" &&
          plugin.trustedOfficialInstall === true &&
          plugin.channels.some(
            (channel) => normalizeOptionalLowercaseString(channel) === params.channelId,
          ) &&
          resolveManifestOwnerBasePolicyBlock({ plugin, normalizedConfig }) === null,
      )
      .toSorted((left, right) => left.id.localeCompare(right.id));
  } catch {
    // Snapshot reads must never turn a missing channel artifact into a hard failure.
    return [];
  }
}

function findChannelMediaContractApi(params: {
  channelId: string | null | undefined;
  cfg: OpenClawConfig;
  resolver: ChannelMediaRootResolver;
}): ChannelMediaContractApi | undefined {
  const channelId = normalizeOptionalLowercaseString(params.channelId);
  if (!channelId) {
    return undefined;
  }
  // Resolve only the narrow contract artifact, never the full channel bootstrap:
  // a missing artifact stays optional, but an artifact that resolves and then
  // fails to initialize must propagate instead of reading as "no contract".
  const bundled = loadBundledPluginPublicArtifactModuleFromCandidatesSync<ChannelMediaContractApi>({
    dirName: channelId,
    artifactCandidates: [CHANNEL_MEDIA_CONTRACT_ARTIFACT],
  });
  if (bundled && typeof bundled[params.resolver] === "function") {
    return bundled;
  }
  for (const owner of resolveInstalledChannelMediaContractOwners({ channelId, cfg: params.cfg })) {
    try {
      const loaded = loadPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
        pluginRoot: owner.rootDir,
        artifactBasename: CHANNEL_MEDIA_CONTRACT_ARTIFACT,
        origin: "global",
      });
      if (typeof loaded[params.resolver] === "function") {
        return loaded;
      }
    } catch (error) {
      if (!(error instanceof MissingPublicSurfaceError)) {
        throw error;
      }
    }
  }
  return undefined;
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
  return contractApi?.resolveInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
  });
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
  return contractApi?.resolveRemoteInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}
