import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function resolveDoctorUserPath(
  input: string,
  params: { env: NodeJS.ProcessEnv; homedir: () => string },
): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return path.resolve(params.env.HOME?.trim() || params.homedir());
  }
  if (/^~[\\/]/.test(trimmed)) {
    return path.resolve(
      params.env.HOME?.trim() || params.homedir(),
      trimmed.slice(2).replace(/^[\\/]/, ""),
    );
  }
  return path.resolve(trimmed);
}

export function listSandboxWorkspaceDirs(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}): string[] {
  const dirs = new Set<string>();
  for (const agentId of listAgentIds(params.cfg)) {
    const sandbox = resolveSandboxConfigForAgent(params.cfg, agentId);
    if (sandbox.mode === "off" || sandbox.workspaceAccess === "rw") {
      continue;
    }
    const workspaceRoot = resolveDoctorUserPath(sandbox.workspaceRoot, params);
    if (sandbox.scope === "shared") {
      dirs.add(workspaceRoot);
      continue;
    }
    if (sandbox.scope === "agent") {
      const layout = resolveSandboxWorkspaceLayoutPaths({
        cfg: { ...sandbox, workspaceRoot },
        rawSessionKey: `agent:${agentId}:main`,
        workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId, params.env),
      });
      dirs.add(layout.sandboxWorkspaceDir);
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.add(path.join(workspaceRoot, entry.name));
      }
    }
  }
  return [...dirs];
}
