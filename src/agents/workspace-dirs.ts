/**
 * Agent workspace directory collection.
 *
 * File sync and cleanup paths use this to enumerate configured agent workspaces
 * plus the default agent workspace without duplicating agent-scope logic.
 */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";

/** Lists unique workspace directories for configured agents and the default agent. */
export function listAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}

/**
 * Lists sandbox workspace copies that can hold retired workspace state.
 *
 * Sandboxed agents with non-`rw` access run against a copy under the sandbox
 * workspace root instead of the configured workspace, so the configured-dir
 * scan never sees legacy files there while the runtime gate still blocks on
 * them. Doctor must enumerate these copies to offer the advertised repair.
 */
export function listSandboxWorkspaceCopyDirs(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string[] {
  const agentIds = new Set<string>();
  const list = params.cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        agentIds.add(entry.id);
      }
    }
  }
  agentIds.add(resolveDefaultAgentId(params.cfg));
  const dirs = new Set<string>();
  for (const agentId of agentIds) {
    // A broken sandbox section must not take down the whole Doctor scan; other
    // sources still need detection and repair.
    try {
      const sandbox = resolveSandboxConfigForAgent(params.cfg, agentId);
      if (sandbox.mode === "off" || sandbox.workspaceAccess === "rw") {
        continue;
      }
      // resolveSandboxConfigForAgent falls back to the process state dir; bind an
      // unset root to the state dir Doctor is actually repairing.
      const configuredRoot =
        resolveAgentConfig(params.cfg, agentId)?.sandbox?.workspaceRoot ??
        params.cfg.agents?.defaults?.sandbox?.workspaceRoot;
      const root = configuredRoot
        ? resolveUserPath(configuredRoot, params.env, params.homedir)
        : path.join(params.stateDir, "sandboxes");
      if (sandbox.scope === "shared") {
        dirs.add(root);
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.add(path.join(root, entry.name));
        }
      }
    } catch {
      continue;
    }
  }
  return [...dirs];
}
