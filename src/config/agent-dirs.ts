// Resolves agent-specific config and workspace directories.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";
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

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

function sameFsObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Probe whether `value` lives on a case-insensitive volume.
 * Walks to the closest existing parent so configured agentDirs need not exist yet.
 * Mirrors the trusted-bin path probe so collision identity matches real FS semantics.
 */
function pathCaseInsensitive(value: string): boolean {
  let candidate = value;
  for (;;) {
    const swapped = swapAsciiCase(candidate);
    if (swapped !== candidate) {
      try {
        const original = fs.statSync(candidate);
        try {
          const alternate = fs.statSync(swapped);
          return sameFsObject(original, alternate);
        } catch {
          // Alternate case path missing while original exists → case-sensitive volume.
          return false;
        }
      } catch {
        // Path may not exist yet; probe the closest existing parent.
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // Unknown root: Windows volumes are case-insensitive by default; POSIX is not.
      return process.platform === "win32";
    }
    candidate = parent;
  }
}

/**
 * Collision key for agentDir identity.
 * Case-insensitive volumes (common macOS APFS / Windows NTFS) fold case so
 * AgentA and agenta cannot share auth state under different spellings.
 * Case-sensitive volumes keep distinct case paths as distinct agent dirs.
 */
function canonicalizeAgentDir(agentDir: string): string {
  const resolved = path.resolve(agentDir);
  if (pathCaseInsensitive(resolved)) {
    return normalizeLowercaseStringOrEmpty(resolved);
  }
  return resolved;
}

function collectReferencedAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  ids.add(normalizeAgentId(defaultAgentId));

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

function resolveEffectiveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): string {
  const id = normalizeAgentId(agentId);
  const configured = Array.isArray(cfg.agents?.list)
    ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir
    : undefined;
  const trimmed = configured?.trim();
  if (trimmed) {
    return resolveUserPath(trimmed);
  }
  const env = deps?.env ?? process.env;
  const root = resolveStateDir(
    env,
    deps?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
  );
  return path.join(root, "agents", id, "agent");
}

/** Finds agent ids whose effective agentDir would share auth/session state. */
export function findDuplicateAgentDirs(
  cfg: OpenClawConfig,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): DuplicateAgentDir[] {
  const byDir = new Map<string, { agentDir: string; agentIds: string[] }>();

  for (const agentId of collectReferencedAgentIds(cfg)) {
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
    "Fix: remove the shared agents.list[].agentDir override (or give each agent its own directory).",
    "If you want to share credentials, copy auth-profiles.json instead of sharing the entire agentDir.",
  ];
  return lines.join("\n");
}
