import { execFile } from "node:child_process";
/**
 * Git-based agent registry sync.
 *
 * Syncs agent registries from git repos, parses registry.json manifests,
 * and maintains a local cache for offline support.
 */
import { readFile, writeFile, mkdir, readdir, cp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  RegistryManifestSchema,
  AgentManifestSchema,
  type RegistryManifest,
  type AgentManifest,
  type AgentMarketplaceConfig,
} from "./zod-schema.agent-manifest.js";

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export interface RegistryEntry {
  id: string;
  name: string;
  url: string;
  authTokenEnv?: string;
  description?: string;
  visibility?: "public" | "private";
  enabled?: boolean;
}

export interface SyncedAgent {
  id: string;
  name: string;
  version: string;
  tier: number;
  department: string;
  registryId: string;
  manifest?: AgentManifest;
  localPath: string;
}

export interface SyncResult {
  registry: RegistryEntry;
  agents: SyncedAgent[];
  errors: string[];
  syncedAt: string;
}

// ── Cache paths ──────────────────────────────────────────────────────────────

function cacheDir(): string {
  return join(homedir(), ".openclaw", "agent-registry-cache");
}

function registryCacheDir(registryId: string): string {
  return join(cacheDir(), registryId);
}

function syncMetaPath(registryId: string): string {
  return join(registryCacheDir(registryId), ".sync-meta.json");
}

// ── Git operations ───────────────────────────────────────────────────────────

async function gitCloneOrPull(
  url: string,
  targetDir: string,
  authToken?: string,
): Promise<{ commit: string }> {
  // Build authenticated URL if token provided
  let authUrl = url;
  if (authToken) {
    const parsed = new URL(url);
    parsed.username = "oauth2";
    parsed.password = authToken;
    authUrl = parsed.toString();
  }

  try {
    // Try pull first (repo already cloned)
    await execFileAsync("git", ["-C", targetDir, "pull", "--rebase", "--quiet"], {
      timeout: 60_000,
    });
  } catch {
    // Clone fresh
    await mkdir(targetDir, { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await execFileAsync("git", ["clone", "--depth", "1", "--quiet", authUrl, targetDir], {
      timeout: 120_000,
    });
  }

  // Get current commit
  const { stdout } = await execFileAsync("git", ["-C", targetDir, "rev-parse", "HEAD"]);
  return { commit: stdout.trim() };
}

// ── Registry manifest parsing ────────────────────────────────────────────────

async function loadRegistryManifest(dir: string): Promise<RegistryManifest | null> {
  try {
    const content = await readFile(join(dir, "registry.json"), "utf-8");
    const parsed = JSON.parse(content);
    const result = RegistryManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function loadAgentManifestFromPath(agentDir: string): Promise<AgentManifest | null> {
  try {
    const content = await readFile(join(agentDir, "agent.yaml"), "utf-8");
    const parsed = parseYaml(content);
    const result = AgentManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ── Sync a single registry ───────────────────────────────────────────────────

export async function syncRegistry(
  registry: RegistryEntry,
  log: (msg: string) => void = () => {},
): Promise<SyncResult> {
  const errors: string[] = [];
  const agents: SyncedAgent[] = [];
  const localDir = registryCacheDir(registry.id);

  // Resolve auth token from environment
  const authToken = registry.authTokenEnv ? process.env[registry.authTokenEnv] : undefined;

  if (registry.visibility === "private" && registry.authTokenEnv && !authToken) {
    errors.push(`Auth token env var "${registry.authTokenEnv}" is not set`);
    return { registry, agents, errors, syncedAt: new Date().toISOString() };
  }

  // Clone or pull
  let commit = "unknown";
  try {
    log(`Syncing ${registry.name} from ${registry.url}...`);
    const result = await gitCloneOrPull(registry.url, localDir, authToken);
    commit = result.commit;
  } catch (err) {
    errors.push(`Git sync failed: ${(err as Error).message}`);
    return { registry, agents, errors, syncedAt: new Date().toISOString() };
  }

  // Parse registry.json
  const manifest = await loadRegistryManifest(localDir);
  if (!manifest) {
    // No registry.json — try scanning agents/ subdirectory directly
    const agentsDir = join(localDir, "agents");
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const agentPath = join(agentsDir, entry.name);
        const agentManifest = await loadAgentManifestFromPath(agentPath);
        if (agentManifest) {
          agents.push({
            id: `${registry.id}/${agentManifest.id}`,
            name: agentManifest.name,
            version: agentManifest.version,
            tier: agentManifest.tier,
            department: agentManifest.department,
            registryId: registry.id,
            manifest: agentManifest,
            localPath: agentPath,
          });
        }
      }
    } catch {
      errors.push("No registry.json found and no agents/ directory");
    }
  } else {
    // Load agents referenced in registry.json
    for (const entry of manifest.agents) {
      const agentPath = join(localDir, entry.path);
      const agentManifest = await loadAgentManifestFromPath(agentPath);
      agents.push({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        tier: entry.tier,
        department: entry.department,
        registryId: registry.id,
        manifest: agentManifest ?? undefined,
        localPath: agentPath,
      });
    }
  }

  // Save sync metadata
  const syncedAt = new Date().toISOString();
  const meta = { registryId: registry.id, commit, syncedAt, agentCount: agents.length };
  await mkdir(localDir, { recursive: true });
  await writeFile(syncMetaPath(registry.id), JSON.stringify(meta, null, 2));

  log(`Synced ${agents.length} agents from ${registry.name} (${commit.slice(0, 7)})`);
  return { registry, agents, errors, syncedAt };
}

// ── Sync all registries ──────────────────────────────────────────────────────

export async function syncAllRegistries(
  config: AgentMarketplaceConfig | undefined,
  log: (msg: string) => void = () => {},
): Promise<SyncResult[]> {
  const registries = config?.registries ?? [];
  const enabled = registries.filter((r) => r.enabled !== false);

  if (enabled.length === 0) {
    log("No registries configured.");
    return [];
  }

  const results: SyncResult[] = [];
  for (const reg of enabled) {
    const result = await syncRegistry(
      {
        id: reg.id,
        name: reg.name,
        url: reg.url,
        authTokenEnv: reg.auth_token_env,
        description: reg.description,
        visibility: reg.visibility,
        enabled: reg.enabled,
      },
      log,
    );
    results.push(result);
  }

  return results;
}

// ── Offline: load from cache ─────────────────────────────────────────────────

export async function loadCachedAgents(registryId: string): Promise<SyncedAgent[]> {
  const localDir = registryCacheDir(registryId);
  const agents: SyncedAgent[] = [];

  const manifest = await loadRegistryManifest(localDir);
  if (manifest) {
    for (const entry of manifest.agents) {
      const agentPath = join(localDir, entry.path);
      const agentManifest = await loadAgentManifestFromPath(agentPath);
      agents.push({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        tier: entry.tier,
        department: entry.department,
        registryId,
        manifest: agentManifest ?? undefined,
        localPath: agentPath,
      });
    }
  } else {
    // Scan agents/ directory
    const agentsDir = join(localDir, "agents");
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      for (const entry of entries.filter((e) => e.isDirectory())) {
        const agentPath = join(agentsDir, entry.name);
        const agentManifest = await loadAgentManifestFromPath(agentPath);
        if (agentManifest) {
          agents.push({
            id: `${registryId}/${agentManifest.id}`,
            name: agentManifest.name,
            version: agentManifest.version,
            tier: agentManifest.tier,
            department: agentManifest.department,
            registryId,
            manifest: agentManifest,
            localPath: agentPath,
          });
        }
      }
    } catch {
      // No cache available
    }
  }

  return agents;
}

// ── Install agent from synced registry ───────────────────────────────────────

export async function installFromRegistry(
  syncedAgent: SyncedAgent,
  targetDir: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await cp(syncedAgent.localPath, targetDir, { recursive: true });
}
