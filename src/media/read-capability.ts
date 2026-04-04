import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import { getAgentScopedMediaLocalRootsForSources } from "./local-roots.js";

export function createAgentScopedHostMediaReadFile(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): OutboundMediaReadFile | undefined {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({
      cfg: params.cfg,
      agentId: params.agentId,
    })
  ) {
    return undefined;
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

export function resolveAgentScopedOutboundMediaAccess(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  mediaSources?: readonly string[];
  workspaceDir?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaReadFile;
}): OutboundMediaAccess {
  const localRoots =
    params.mediaAccess?.localRoots ??
    getAgentScopedMediaLocalRootsForSources({
      cfg: params.cfg,
      agentId: params.agentId,
      mediaSources: params.mediaSources,
    });
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const readFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    createAgentScopedHostMediaReadFile({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: resolvedWorkspaceDir,
    });
  return {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}
