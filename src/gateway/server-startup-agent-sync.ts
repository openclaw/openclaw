/**
 * Startup agent config reconciliation.
 *
 * On gateway start, compares YAML agent manifests (agents/ directory)
 * against config agents.list and auto-applies non-destructive sync
 * (adds missing entries, fixes field drift, rebuilds allowAgents).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  deriveAllowAgents,
  detectDrift,
  applySync,
  type ConfigAgentEntry,
} from "../config/agent-config-sync.js";
import { loadAgentFromDir } from "../config/agent-manifest-validation.js";
import { loadBlueprint, deployAgent } from "../config/agent-workspace-deploy.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import type { AgentManifest } from "../config/zod-schema.agent-manifest.js";

const BUNDLED_AGENTS_DIR = join(import.meta.dirname, "..", "agents");
/** Directories that are not agent folders. */
const EXCLUDED_DIRS = new Set(["personas", "_archive"]);

async function loadManifests(): Promise<AgentManifest[]> {
  const manifests: AgentManifest[] = [];
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = await readdir(BUNDLED_AGENTS_DIR, { withFileTypes: true });
  } catch {
    return manifests;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    const agentDir = join(BUNDLED_AGENTS_DIR, entry.name);
    // Supports both unified AGENT.md (frontmatter) and legacy agent.yaml
    const result = await loadAgentFromDir(agentDir);
    if (result.manifest) {
      manifests.push(result.manifest);
    }
  }
  return manifests;
}

export async function reconcileAgentConfigOnStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const manifests = await loadManifests();
  if (manifests.length === 0) {
    return;
  }

  const nonBundles = manifests.filter((m) => !m.is_bundle);
  const derived = deriveAllowAgents(nonBundles);

  // Re-read config to get freshest state
  const cfg = loadConfig();
  const configEntries = (cfg.agents?.list ?? []) as ConfigAgentEntry[];
  const drift = detectDrift(nonBundles, configEntries, derived);

  if (!drift.hasDrift) {
    return;
  }

  // Apply non-destructive sync (adds missing, fixes fields, rebuilds allowAgents)
  const synced = applySync(nonBundles, configEntries, drift);
  const updatedConfig = { ...cfg, agents: { ...cfg.agents, list: synced } };
  await writeConfigFile(updatedConfig);

  params.log.warn(
    `agent config reconciled: ${drift.issues.length} issue(s) fixed (${drift.missingInConfig.length} added, ${drift.issues.filter((i) => i.type.endsWith("_mismatch")).length} field updates)`,
  );

  // Deploy workspace files for agents that need it (version-managed)
  await deployAgentWorkspacesOnStartup(nonBundles, params.log);
}

async function deployAgentWorkspacesOnStartup(
  manifests: AgentManifest[],
  log: { warn: (msg: string) => void },
): Promise<void> {
  let deployed = 0;
  const cfg = loadConfig();

  for (const manifest of manifests) {
    try {
      const blueprintDir = join(BUNDLED_AGENTS_DIR, manifest.id);
      const blueprint = await loadBlueprint(blueprintDir);
      if (!blueprint) {
        continue;
      }

      const configId = manifest.id === "operator1" ? "main" : manifest.id;
      const workspaceDir = resolveAgentWorkspaceDir(cfg, configId);
      const result = await deployAgent(blueprint, workspaceDir);
      if (result.isFirstDeploy || result.isUpgrade) {
        deployed++;
      }
    } catch {
      // Individual agent deploy failure is non-fatal
    }
  }

  if (deployed > 0) {
    log.warn(`workspace deploy: ${deployed} agent(s) deployed/upgraded`);
  }
}
