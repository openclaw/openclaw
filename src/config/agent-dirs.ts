// Resolves agent-specific config and workspace directories.
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import { isPathCaseInsensitive } from "../infra/path-case.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.js";

type DuplicateAgentDir = {
  agentDir: string;
  agentIds: string[];
};

/** Error thrown when multiple configured agents resolve to the same state directory. */
export class DuplicateAgentDirError extends Error {
  readonly duplicates: DuplicateAgentDir[];

  constructor(duplicates: DuplicateAgentDir[]) {
    super(formatDuplicateAgentDirError(duplicates));
    this.name = "DuplicateAgentDirError";
    this.duplicates = duplicates;
  }
}

function canonicalizeAgentDir(agentDir: string): string {
  let resolved = path.resolve(agentDir);
  try {
    const prefix = resolvePathPrefixSync(resolved);
    resolved = path.join(prefix.existingPath, ...prefix.unresolvedSegments);
  } catch {
    // Unreadable paths keep their configured spelling for best-effort comparison.
  }
  return isPathCaseInsensitive(resolved) ? normalizeLowercaseStringOrEmpty(resolved) : resolved;
}

function collectReferencedAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();

  const agents = listAgentEntries(cfg);
  const defaultAgentId = agents.find((agent) => agent?.default)?.id;
  if (defaultAgentId) {
    ids.add(normalizeAgentId(defaultAgentId));
  }

  for (const entry of agents) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }

  const bindings = cfg.bindings;
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      const id = binding?.agentId;
      if (typeof id === "string" && id.trim()) {
        ids.add(normalizeAgentId(id));
      }
    }
  }

  return [...ids];
}

/** Finds agent ids whose effective agentDir would share auth/session state. */
export function findDuplicateAgentDirs(
  cfg: OpenClawConfig,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): DuplicateAgentDir[] {
  const agentIds = collectReferencedAgentIds(cfg);
  if (agentIds.length < 2) {
    return [];
  }
  const byDir = new Map<string, { agentDir: string; agentIds: string[] }>();

  for (const agentId of agentIds) {
    const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
    const key = canonicalizeAgentDir(agentDir);
    const entry = byDir.get(key);
    if (entry) {
      entry.agentIds.push(agentId);
    } else {
      byDir.set(key, { agentDir, agentIds: [agentId] });
    }
  }

  return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}

/** Formats duplicate agentDir conflicts with the remediation operators should take. */
export function formatDuplicateAgentDirError(dups: DuplicateAgentDir[]): string {
  const lines: string[] = [
    "Duplicate agentDir detected (multi-agent config).",
    "Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.",
    "",
    "Conflicts:",
    ...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
    "",
    "Fix: remove the shared agents.entries.*.agentDir override (or give each agent its own directory).",
    "Auth profiles live in each agent's SQLite store, so a shared agentDir is not how credentials are shared: give each agent its own directory and either leave its store empty to inherit the main agent's profiles, or log it in with `openclaw models auth login`.",
  ];
  return lines.join("\n");
}
