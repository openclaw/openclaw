import type { OpenClawConfig } from "../config/config.js";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import { resolveAccessPolicyForAgent } from "../infra/access-policy-file.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  permissions?: AccessPolicyConfig;
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  permissions?: AccessPolicyConfig;
}): ToolFsPolicy {
  return {
    workspaceOnly: params.workspaceOnly === true,
    permissions: params.permissions,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  permissions?: AccessPolicyConfig;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    permissions: resolveAccessPolicyForAgent(params.agentId),
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}
