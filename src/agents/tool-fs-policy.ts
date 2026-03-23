import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
};

export function createToolFsPolicy(params: { workspaceOnly?: boolean }): ToolFsPolicy {
  return {
    // Default to true: restrict file tools to the workspace directory unless explicitly disabled.
    workspaceOnly: params.workspaceOnly !== false,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  // Default to true when unset — secure by default.
  return resolveToolFsConfig(params).workspaceOnly !== false;
}
