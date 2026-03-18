import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsPolicy = {
  readWorkspaceOnly: boolean;
  writeWorkspaceOnly: boolean;
  editWorkspaceOnly: boolean;
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  readWorkspaceOnly?: boolean;
  writeWorkspaceOnly?: boolean;
  editWorkspaceOnly?: boolean;
}): ToolFsPolicy {
  return {
    readWorkspaceOnly: params.readWorkspaceOnly ?? params.workspaceOnly ?? false,
    writeWorkspaceOnly: params.writeWorkspaceOnly ?? params.workspaceOnly ?? false,
    editWorkspaceOnly: params.editWorkspaceOnly ?? params.workspaceOnly ?? false,
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  readWorkspaceOnly?: boolean;
  writeWorkspaceOnly?: boolean;
  editWorkspaceOnly?: boolean;
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  const workspaceOnly = agentFs?.workspaceOnly ?? globalFs?.workspaceOnly;
  return {
    workspaceOnly,
    readWorkspaceOnly:
      agentFs?.readWorkspaceOnly ??
      agentFs?.workspaceOnly ??
      globalFs?.readWorkspaceOnly ??
      workspaceOnly,
    writeWorkspaceOnly:
      agentFs?.writeWorkspaceOnly ??
      agentFs?.workspaceOnly ??
      globalFs?.writeWorkspaceOnly ??
      workspaceOnly,
    editWorkspaceOnly:
      agentFs?.editWorkspaceOnly ??
      agentFs?.workspaceOnly ??
      globalFs?.editWorkspaceOnly ??
      workspaceOnly,
  };
}

export function resolveEffectiveToolFsReadWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).readWorkspaceOnly === true;
}

export function resolveEffectiveToolFsWriteWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).writeWorkspaceOnly === true;
}

export function resolveEffectiveToolFsEditWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).editWorkspaceOnly === true;
}
