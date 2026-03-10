/**
 * Agent installation scope management.
 *
 * Handles local → project → user scope resolution, lock file paths,
 * and cross-scope dependency checking.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  AgentManifestSchema,
  AgentsLockSchema,
  type AgentManifest,
  type AgentsLock,
} from "./zod-schema.agent-manifest.js";

// ── Scope types ──────────────────────────────────────────────────────────────

export type AgentScope = "local" | "project" | "user";

export interface ScopedAgent {
  manifest: AgentManifest;
  scope: AgentScope;
  dir: string;
}

// ── Scope paths ──────────────────────────────────────────────────────────────

/**
 * Resolve the agents directory for a given scope.
 *
 * - local:   `<projectRoot>/.openclaw/agents.local/`
 * - project: `<projectRoot>/.openclaw/agents/`
 * - user:    `~/.openclaw/agents/`
 */
export function agentsDirForScope(scope: AgentScope, projectRoot: string): string {
  switch (scope) {
    case "local":
      return join(projectRoot, ".openclaw", "agents.local");
    case "project":
      return join(projectRoot, ".openclaw", "agents");
    case "user":
      return join(homedir(), ".openclaw", "agents");
  }
}

/**
 * Resolve the lock file path for a given scope.
 */
export function lockFileForScope(scope: AgentScope, projectRoot: string): string {
  switch (scope) {
    case "local":
      return join(projectRoot, ".openclaw", "agents.local-lock.yaml");
    case "project":
      return join(projectRoot, ".openclaw", "agents-lock.yaml");
    case "user":
      return join(homedir(), ".openclaw", "agents-lock.yaml");
  }
}

// ── Scope resolution ─────────────────────────────────────────────────────────

/**
 * Resolution order: local → project → user (narrowest wins).
 * A local-scope agent with the same ID as a user-scope agent overrides it.
 */
const SCOPE_PRIORITY: AgentScope[] = ["local", "project", "user"];

/**
 * Load all agents from a single scope directory.
 */
async function loadAgentsFromScope(scope: AgentScope, projectRoot: string): Promise<ScopedAgent[]> {
  const dir = agentsDirForScope(scope, projectRoot);
  let entries: string[];
  try {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    entries = dirEntries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // Directory doesn't exist yet
  }

  const agents: ScopedAgent[] = [];
  for (const entry of entries) {
    const agentDir = join(dir, entry);
    try {
      const yamlContent = await readFile(join(agentDir, "agent.yaml"), "utf-8");
      const parsed = parseYaml(yamlContent);
      const result = AgentManifestSchema.safeParse(parsed);
      if (result.success) {
        agents.push({ manifest: result.data, scope, dir: agentDir });
      }
    } catch {
      // Skip invalid/incomplete agents
    }
  }
  return agents;
}

/**
 * Load and merge agents from all scopes. Narrowest scope wins on ID collision.
 */
export async function resolveAllAgents(projectRoot: string): Promise<ScopedAgent[]> {
  const merged = new Map<string, ScopedAgent>();

  // Load broadest scope first (user), then narrower scopes overwrite.
  // Order: user → project → local (last write wins, so local wins on collision).
  for (const scope of [...SCOPE_PRIORITY].toReversed()) {
    const agents = await loadAgentsFromScope(scope, projectRoot);
    for (const agent of agents) {
      merged.set(agent.manifest.id, agent);
    }
  }

  return Array.from(merged.values());
}

// ── Lock file operations ─────────────────────────────────────────────────────

/**
 * Read a lock file, returning null if it doesn't exist or is invalid.
 */
export async function readLockFile(
  scope: AgentScope,
  projectRoot: string,
): Promise<AgentsLock | null> {
  const path = lockFileForScope(scope, projectRoot);
  try {
    const content = await readFile(path, "utf-8");
    const parsed = parseYaml(content);
    const result = AgentsLockSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Write a lock file for a given scope.
 */
export async function writeLockFile(
  scope: AgentScope,
  projectRoot: string,
  lock: AgentsLock,
): Promise<void> {
  const path = lockFileForScope(scope, projectRoot);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, stringifyYaml(lock), "utf-8");
}

/**
 * Add or update an agent entry in the lock file.
 */
export async function addToLockFile(
  scope: AgentScope,
  projectRoot: string,
  agentId: string,
  entry: {
    version: string;
    resolved?: string;
    checksum?: string;
    requires?: string;
  },
): Promise<void> {
  const lock = (await readLockFile(scope, projectRoot)) ?? {
    lockfile_version: 1 as const,
    agents: {},
  };

  if (!lock.agents) {
    lock.agents = {};
  }
  lock.agents[agentId] = {
    version: entry.version,
    resolved: entry.resolved,
    checksum: entry.checksum,
    installed_at: new Date().toISOString(),
    scope,
    requires: entry.requires,
  };

  await writeLockFile(scope, projectRoot, lock);
}

/**
 * Remove an agent entry from the lock file.
 */
export async function removeFromLockFile(
  scope: AgentScope,
  projectRoot: string,
  agentId: string,
): Promise<void> {
  const lock = await readLockFile(scope, projectRoot);
  if (!lock?.agents?.[agentId]) {
    return;
  }

  delete lock.agents[agentId];
  await writeLockFile(scope, projectRoot, lock);
}
