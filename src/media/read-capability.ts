import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveGroupToolPolicy } from "../agents/pi-tools.policy.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveToolFsConfig,
} from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import type { FsRoot } from "../config/types.tools.js";
import { readLocalFileSafely, readPathWithinRoot, SafeOpenError } from "../infra/fs-safe.js";
<<<<<<< HEAD
import { normalizeOptionalString } from "../shared/string-coerce.js";
=======
>>>>>>> 774baf38a1 (fix(media): skip Windows drive paths on non-Windows; preserve in-root read errors)
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import {
  getAgentScopedMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
} from "./local-roots.js";

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

function isAgentScopedHostMediaReadAllowed(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({
      cfg: params.cfg,
      agentId: params.agentId,
    })
  ) {
    return false;
  }
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId,
    senderId: normalizeOptionalString(params.requesterSenderId),
    senderName: normalizeOptionalString(params.requesterSenderName),
    senderUsername: normalizeOptionalString(params.requesterSenderUsername),
    senderE164: normalizeOptionalString(params.requesterSenderE164),
  });
  if (groupPolicy && !isToolAllowedByPolicies("read", [groupPolicy])) {
    return false;
  }
  return true;
}

export function createAgentScopedHostMediaReadFile(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
    ignoreConfiguredRoots?: boolean;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaReadFile | undefined {
  if (!isAgentScopedHostMediaReadAllowed(params)) {
    return undefined;
  }
  if (!params.ignoreConfiguredRoots) {
    const fsConfig = resolveToolFsConfig({ cfg: params.cfg, agentId: params.agentId });
    // When tools.fs.roots is configured, return a root-scoped readFile that
    // only allows reads inside the configured roots. This keeps hostReadCapability
    // active (so assertHostReadMediaAllowed still runs) while enforcing roots.
    if (fsConfig.roots !== undefined) {
      if (fsConfig.roots.length === 0) {
        return undefined;
      }
      return createRootScopedReadFile(fsConfig.roots, params.workspaceDir);
    }
  }
  const inferredWorkspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const workspaceRoot = resolveWorkspaceRoot(inferredWorkspaceDir);
  return async (filePath: string) => {
    const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
    return (await readLocalFileSafely({ filePath: resolvedPath })).buffer;
  };
}

function createRootScopedReadFile(roots: FsRoot[], workspaceDir?: string): OutboundMediaReadFile {
  const workspaceRoot = resolveWorkspaceRoot(workspaceDir);
  return async (filePath: string) => {
    const resolvedPath = path.resolve(resolvePathFromInput(filePath, workspaceRoot));
    // Try each configured root — use readPathWithinRoot for dir roots (alias-safe,
    // validates canonical path after symlink resolution) and exact match for file roots.
    for (const root of roots) {
      const rootPath = path.resolve(root.path);
      if (root.kind === "file") {
        const match =
          process.platform === "win32"
            ? resolvedPath.toLowerCase() === rootPath.toLowerCase()
            : resolvedPath === rootPath;
        if (match) {
          // Use readPathWithinRoot with the parent dir as root to reject hardlinks
          // and validate the canonical path, same as dir roots.
          const parentDir = path.dirname(rootPath);
          try {
            const result = await readPathWithinRoot({ rootDir: parentDir, filePath: resolvedPath });
            return result.buffer;
          } catch {
            throw new Error(
              `Access denied: media file root '${filePath}' failed alias/hardlink validation`,
            );
          }
        }
        continue;
      }
      try {
        const result = await readPathWithinRoot({ rootDir: rootPath, filePath: resolvedPath });
        return result.buffer;
      } catch (err) {
        // Only continue to next root if the path is outside this root.
        // Preserve real in-root errors (permission, not-found, alias escape).
        if (err instanceof SafeOpenError && err.code === "outside-workspace") {
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `Access denied: media path '${filePath}' is outside configured filesystem roots`,
    );
  };
}

export function resolveAgentScopedOutboundMediaAccess(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
    ignoreConfiguredRoots?: boolean;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaAccess {
  const hostMediaReadAllowed = isAgentScopedHostMediaReadAllowed(params);
  const localRoots =
    params.mediaAccess?.localRoots ??
    (params.ignoreConfiguredRoots
      ? getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources,
          ignoreConfiguredRoots: true,
        })
      : hostMediaReadAllowed
        ? getAgentScopedMediaLocalRootsForSources({
            cfg: params.cfg,
            agentId: params.agentId,
            mediaSources: params.mediaSources,
          })
        : getAgentScopedMediaLocalRoots(params.cfg, params.agentId));
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const readFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    (hostMediaReadAllowed
      ? createAgentScopedHostMediaReadFile({
          cfg: params.cfg,
          agentId: params.agentId,
          workspaceDir: resolvedWorkspaceDir,
          ignoreConfiguredRoots: params.ignoreConfiguredRoots,
          sessionKey: params.sessionKey,
          messageProvider: params.messageProvider,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          accountId: params.accountId,
          requesterSenderId: params.requesterSenderId,
          requesterSenderName: params.requesterSenderName,
          requesterSenderUsername: params.requesterSenderUsername,
          requesterSenderE164: params.requesterSenderE164,
        })
      : undefined);
  return {
    ...(localRoots !== undefined ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}
