import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveGroupToolPolicy } from "../agents/agent-tools.policy.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveManagedMediaRoot } from "../agents/sandbox-paths.js";
import { resolveSenderToolPolicy } from "../agents/sender-tool-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { captureAgentWorkspaceOutboundMedia } from "../agents/workspace-access.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenResult } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveConfigDir } from "../utils.js";
import { createBoundedOutboundMediaReadFile, readOutboundMediaFile } from "./bounded-read-file.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import { openLocalMediaFile, readLocalMediaFile } from "./local-media-access.js";
import {
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
} from "./local-roots.js";

/** Internal host access; native descriptors are not part of the plugin SDK. */
export type HostOutboundMediaAccess = OutboundMediaAccess & {
  /** A native descriptor, or undefined when a transport reader owns this path. */
  openFile?: (filePath: string, options: { maxBytes: number }) => Promise<OpenResult | undefined>;
};

type OutboundHostMediaPolicyContext = {
  sessionKey?: string;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
};

function isAgentScopedMediaReadAllowedByToolPolicy(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  const senderPolicy = resolveSenderToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  return isToolAllowedByPolicies("read", [groupPolicy, senderPolicy]);
}

function getManagedMediaLocalRoots(mediaSources?: readonly string[]): readonly string[] {
  const roots = new Set([path.join(resolveConfigDir(), "media", "outbound")]);
  for (const source of mediaSources ?? []) {
    const managedRoot = resolveManagedMediaRoot(source);
    if (managedRoot) {
      roots.add(managedRoot);
    }
  }
  return Array.from(roots);
}

function appendWorkspaceDirToLocalRoots(
  roots: readonly string[] | undefined,
  workspaceDir?: string,
): readonly string[] | undefined {
  if (!workspaceDir) {
    return roots;
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots?.length) {
    return [resolvedWorkspaceDir];
  }
  if (roots.some((root) => path.resolve(root) === resolvedWorkspaceDir)) {
    return roots;
  }
  return [...roots, resolvedWorkspaceDir];
}

function createWorkspaceAwareMediaReadFile(params: {
  workspaceMediaAccess?: OutboundMediaAccess;
  hostReadFile?: OutboundMediaReadFile;
  localRoots: readonly string[];
  excludedLocalRoots?: readonly string[];
}): OutboundMediaReadFile | undefined {
  const workspaceReadFile = params.workspaceMediaAccess?.readFile;
  const workspaceLocalRoots = params.workspaceMediaAccess?.localRoots ?? [];
  if (!workspaceReadFile || workspaceLocalRoots.length === 0) {
    return params.hostReadFile;
  }
  return createBoundedOutboundMediaReadFile(async (filePath, options) => {
    const readFile = workspaceOwnsMediaPath(params.workspaceMediaAccess, filePath)
      ? workspaceReadFile
      : params.hostReadFile;
    const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (readFile) {
      return await readOutboundMediaFile(readFile, filePath, { maxBytes });
    }
    return await readLocalMediaFile(filePath, params.localRoots, {
      maxBytes,
      excludedRoots: params.excludedLocalRoots,
    });
  });
}

function workspaceOwnsMediaPath(access: OutboundMediaAccess | undefined, filePath: string) {
  return (
    access?.readFile &&
    access.localRoots?.some((root) => isPathInside(path.resolve(root), path.resolve(filePath)))
  );
}

type AgentScopedOutboundMediaAccessParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
  workspaceDir?: string;
  sessionWorkspaceDir?: string;
  workspaceOnly?: boolean;
  /** False when local execution paths belong to another host. */
  allowHostWorkspace?: boolean;
  mediaAccess?: OutboundMediaAccess;
  /** Workspace-bounded transport reader; sender policy remains owned by this resolver. */
  workspaceMediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaReadFile;
} & OutboundHostMediaPolicyContext;

/** Resolves roots and optional host read capability for outbound media in an agent context. */
export function resolveAgentScopedOutboundMediaAccess(
  params: AgentScopedOutboundMediaAccessParams,
): OutboundMediaAccess {
  return resolveAgentScopedMediaAccess(params, false);
}

/** Adds a bounded native opener for host-owned media staging. */
export function resolveAgentScopedHostOutboundMediaAccess(
  params: AgentScopedOutboundMediaAccessParams,
): HostOutboundMediaAccess {
  return resolveAgentScopedMediaAccess(params, true);
}

function resolveAgentScopedMediaAccess(
  params: AgentScopedOutboundMediaAccessParams,
  includeHostOpener: boolean,
): HostOutboundMediaAccess {
  if (params.allowHostWorkspace === false) {
    return { localRoots: getManagedMediaLocalRoots(params.mediaSources) };
  }
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    params.workspaceMediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const mediaReadAllowed = isAgentScopedMediaReadAllowedByToolPolicy(params);
  const registeredMedia = resolvedWorkspaceDir
    ? captureAgentWorkspaceOutboundMedia(resolvedWorkspaceDir)
    : undefined;
  const managedLocalRoots = getManagedMediaLocalRoots(params.mediaSources);
  const configuredHostLocalRoots =
    params.mediaAccess?.localRoots ??
    (registeredMedia
      ? getAgentScopedMediaLocalRoots(params.cfg, params.agentId, params.sessionWorkspaceDir)
      : getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources,
          sessionWorkspaceDir: params.sessionWorkspaceDir,
          workspaceOnly: params.workspaceOnly,
        }));
  // The remote reader intercepts these namespaces. Native host reads also exclude
  // their opened real paths, so granted ancestor roots can still serve sibling files.
  const registeredRoots =
    registeredMedia && resolvedWorkspaceDir
      ? [path.resolve(resolvedWorkspaceDir), ...registeredMedia.localRoots]
      : [];
  const hostLocalRoots = registeredMedia
    ? configuredHostLocalRoots.filter(
        (root) => !registeredRoots.some((remoteRoot) => isPathInside(remoteRoot, root)),
      )
    : configuredHostLocalRoots;
  const workspaceLocalRoots = [
    ...(params.workspaceMediaAccess?.localRoots ?? []),
    ...(registeredMedia?.localRoots ?? []),
  ];
  const baseLocalRoots = mediaReadAllowed
    ? workspaceLocalRoots.length > 0
      ? Array.from(
          new Set([...hostLocalRoots, ...workspaceLocalRoots].map((root) => path.resolve(root))),
        )
      : hostLocalRoots
    : managedLocalRoots;
  const localRoots =
    mediaReadAllowed && !registeredMedia
      ? appendWorkspaceDirToLocalRoots(baseLocalRoots, resolvedWorkspaceDir)
      : baseLocalRoots;
  let hostReadFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
  if (!hostReadFile && mediaReadAllowed && resolveEffectiveToolFsRootExpansionAllowed(params)) {
    const workspaceRoot = resolveWorkspaceRoot(resolvedWorkspaceDir);
    hostReadFile = createBoundedOutboundMediaReadFile(async (filePath, options) => {
      const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
      return await readLocalMediaFile(resolvedPath, localRoots ?? [], {
        maxBytes: options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
        excludedRoots: registeredRoots,
      });
    });
  }
  const registeredReadFile =
    mediaReadAllowed && registeredMedia
      ? createWorkspaceAwareMediaReadFile({
          workspaceMediaAccess: {
            localRoots: registeredRoots,
            readFile: createBoundedOutboundMediaReadFile((filePath, options) =>
              registeredMedia.readFile(filePath, options?.maxBytes ?? Number.MAX_SAFE_INTEGER),
            ),
          },
          hostReadFile,
          localRoots: localRoots ?? [],
          excludedLocalRoots: registeredRoots,
        })
      : hostReadFile;
  // An explicit sandbox capability owns its declared roots for this turn, even
  // when an rw sandbox uses the same host path as the registered agent workspace.
  const readFile = mediaReadAllowed
    ? createWorkspaceAwareMediaReadFile({
        workspaceMediaAccess: params.workspaceMediaAccess,
        hostReadFile: registeredReadFile,
        localRoots: localRoots ?? [],
        excludedLocalRoots: registeredRoots,
      })
    : undefined;
  const mediaAccess: OutboundMediaAccess = {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
  if (!includeHostOpener) {
    return mediaAccess;
  }
  const openFile: HostOutboundMediaAccess["openFile"] = async (filePath, options) => {
    // The same transport precedence as readFile: a native copy must never read a stale
    // local mirror of a sandbox or remotely owned workspace.
    if (mediaReadAllowed && workspaceOwnsMediaPath(params.workspaceMediaAccess, filePath)) {
      return undefined;
    }
    if (
      registeredMedia &&
      registeredRoots.some((root) => isPathInside(root, path.resolve(filePath)))
    ) {
      return undefined;
    }
    if (mediaReadAllowed && (params.mediaAccess?.readFile || params.mediaReadFile)) {
      return undefined;
    }
    return await openLocalMediaFile(filePath, localRoots ?? [], {
      ...options,
      excludedRoots: registeredRoots,
    });
  };
  return { ...mediaAccess, openFile };
}
