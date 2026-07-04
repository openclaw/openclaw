// Memory host workspace resolution shared by dreaming and public artifact discovery.
import path from "node:path";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type MemoryHostWorkspace = {
  workspaceDir: string;
  agentIds: string[];
};

export type MemoryHostWorkspaceOptions = {
  primaryWorkspaceDir?: string | null;
  primaryAgentId?: string | null;
  env?: NodeJS.ProcessEnv;
};

function normalizePathForComparison(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === "win32" ? lowercasePreservingWhitespace(normalized) : normalized;
}

export function resolveMemoryHostWorkspaces(
  cfg: OpenClawConfig,
  options: MemoryHostWorkspaceOptions = {},
  scope: { allowedAgentIds?: ReadonlySet<string> } = {},
): MemoryHostWorkspace[] {
  const allowedAgentIds = scope.allowedAgentIds;
  const configured = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agentIds: string[] = [];
  const seenAgents = new Set<string>();
  for (const entry of configured) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    if (seenAgents.has(id)) {
      continue;
    }
    if (allowedAgentIds && !allowedAgentIds.has(id)) {
      continue;
    }
    seenAgents.add(id);
    agentIds.push(id);
  }
  if (agentIds.length === 0) {
    const defaultAgentId = resolveDefaultAgentId(cfg);
    if (!allowedAgentIds || allowedAgentIds.has(defaultAgentId)) {
      agentIds.push(defaultAgentId);
    }
  }

  const byWorkspace = new Map<string, MemoryHostWorkspace>();
  const addWorkspace = (workspaceDirRaw: string | undefined, agentIdRaw: string): void => {
    const workspaceDir = workspaceDirRaw?.trim();
    if (!workspaceDir) {
      return;
    }
    const agentId = normalizeAgentId(agentIdRaw);
    if (allowedAgentIds && !allowedAgentIds.has(agentId)) {
      return;
    }
    const key = normalizePathForComparison(workspaceDir);
    const existing = byWorkspace.get(key);
    if (existing) {
      if (!existing.agentIds.includes(agentId)) {
        existing.agentIds.push(agentId);
      }
      return;
    }
    byWorkspace.set(key, { workspaceDir, agentIds: [agentId] });
  };

  for (const agentId of agentIds) {
    addWorkspace(resolveAgentWorkspaceDir(cfg, agentId, options.env), agentId);
  }
  addWorkspace(
    options.primaryWorkspaceDir ?? undefined,
    options.primaryAgentId ?? resolveDefaultAgentId(cfg),
  );
  return [...byWorkspace.values()];
}
