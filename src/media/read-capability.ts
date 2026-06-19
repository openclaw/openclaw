// Media read capability helpers gate file reads by configured media access rules.
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  type FsRootResolved,
  resolveRoots,
  resolveRootScopedPath,
} from "../agents/agent-tools.fs-roots.js";
import { resolveGroupToolPolicy } from "../agents/agent-tools.policy.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import {
  resolveEffectiveToolFsRootExpansionAllowed,
  resolveToolFsConfig,
} from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FsRoot } from "../config/types.tools.js";
import { readFileWithinRoot, readLocalFileSafely } from "../infra/fs-safe.js";
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
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  if (groupPolicy && !isToolAllowedByPolicies("read", [groupPolicy])) {
    return false;
  }
  return true;
}

function shouldIgnoreConfiguredRootsForHostMedia(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  ignoreConfiguredRoots?: boolean;
}): boolean {
  if (params.ignoreConfiguredRoots !== undefined) {
    return params.ignoreConfiguredRoots;
  }
  if (!params.sessionKey) {
    return false;
  }
  return resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  }).sandboxed;
}

/** Creates a host reader bound to the agent workspace and configured local-file safety checks. */
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
  const ignoreConfiguredRoots = shouldIgnoreConfiguredRootsForHostMedia(params);
  if (!ignoreConfiguredRoots) {
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

// Builds a host reader scoped to configured tools.fs.roots. resolveRootScopedPath
// selects the most-specific matching root (file roots require an exact path match,
// dir roots match descendants), so reads outside every configured root are denied
// while reads inside a root flow through the alias/hardlink-safe readFileWithinRoot.
function createRootScopedReadFile(roots: FsRoot[], workspaceDir?: string): OutboundMediaReadFile {
  const workspaceRoot = resolveWorkspaceRoot(workspaceDir);
  const resolvedRoots: FsRootResolved[] = resolveRoots(roots);
  return async (filePath: string) => {
    const resolvedPath = path.resolve(resolvePathFromInput(filePath, workspaceRoot));
    let target: ReturnType<typeof resolveRootScopedPath>;
    try {
      target = resolveRootScopedPath(resolvedPath, "read", resolvedRoots);
    } catch {
      throw new Error(
        `Access denied: media path '${filePath}' is outside configured filesystem roots`,
      );
    }
    const safeRead = await readFileWithinRoot({
      rootDir: target.rootDir,
      relativePath: target.relativePath,
      rejectHardlinks: true,
    });
    return safeRead.buffer;
  };
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

/** Resolves roots and optional host read capability for outbound media in an agent context. */
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
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const hostMediaReadAllowed = isAgentScopedHostMediaReadAllowed(params);
  const ignoreConfiguredRoots = shouldIgnoreConfiguredRootsForHostMedia(params);
  // Even when host reads are denied, keep base roots so generated media remains addressable.
  const baseLocalRoots =
    params.mediaAccess?.localRoots ??
    (hostMediaReadAllowed
      ? getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources,
          ignoreConfiguredRoots,
        })
      : ignoreConfiguredRoots
        ? getAgentScopedMediaLocalRootsForSources({
            cfg: params.cfg,
            agentId: params.agentId,
            ignoreConfiguredRoots: true,
          })
        : getAgentScopedMediaLocalRoots(params.cfg, params.agentId));
  const localRoots = appendWorkspaceDirToLocalRoots(baseLocalRoots, resolvedWorkspaceDir);
  const readFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    (hostMediaReadAllowed
      ? createAgentScopedHostMediaReadFile({
          cfg: params.cfg,
          agentId: params.agentId,
          workspaceDir: resolvedWorkspaceDir,
          ignoreConfiguredRoots,
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
