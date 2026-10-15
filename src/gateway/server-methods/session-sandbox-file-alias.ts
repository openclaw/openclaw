import path from "node:path";
import { resolveSandboxPathMapping } from "../../agents/path-policy.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxMountSelection } from "../../agents/sandbox/workspace-mounts.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function resolveSandboxSessionFileAlias(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry?: InternalSessionEntry;
  root: string;
  filePath: string;
  assertCurrent: () => void;
}): Promise<{ root: string; path: string } | undefined> {
  if (params.filePath.replaceAll("\\", "/").split("/").includes("..")) {
    return undefined;
  }
  if (
    !resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      preparedSessionEntry: params.entry,
    }).sandboxed
  ) {
    return undefined;
  }
  const sandbox = await ensureSandboxWorkspaceForSession({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.root,
  });
  params.assertCurrent();
  if (!sandbox?.containerWorkdir || !sandbox.workspaceAccess) {
    return undefined;
  }
  const sandboxConfig = resolveSandboxConfigForAgent(params.cfg, params.agentId);
  const mounts = resolveSandboxMountSelection({
    workspaceDir: sandbox.workspaceDir,
    agentWorkspaceDir: params.root,
    skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
    workdir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    binds: sandboxConfig.docker.binds,
    readOnlyResourceMounts: sandbox.readOnlyResourceMounts,
  }).mounts;
  const resolved = resolveSandboxPathMapping(
    mounts.map((mount) => ({
      hostRoot: mount.hostPath,
      containerRoot: mount.containerPath,
      source: mount.source,
    })),
    params.filePath,
  );
  if (
    !resolved ||
    (resolved.mapping.source !== "workspace" && resolved.mapping.source !== "agent")
  ) {
    return undefined;
  }
  return {
    root: resolved.mapping.hostRoot,
    path: path.relative(resolved.mapping.hostRoot, resolved.hostPath).split("\\").join("/"),
  };
}
