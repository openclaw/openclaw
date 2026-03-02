import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  readAllowlist: string[];
  writeAllowlist: string[];
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  readAllowlist?: string[];
  writeAllowlist?: string[];
}): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
    readAllowlist: params.readAllowlist ?? [],
    writeAllowlist: params.writeAllowlist ?? [],
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  readAllowlist?: string[];
  writeAllowlist?: string[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    readAllowlist: agentFs?.readAllowlist ?? globalFs?.readAllowlist,
    writeAllowlist: agentFs?.writeAllowlist ?? globalFs?.writeAllowlist,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}
