/**
 * Agent Config Sync Engine.
 *
 * Reconciles YAML agent manifests (design-time truth) with OpenClaw
 * config `agents.list` entries (runtime truth). Detects drift, generates
 * config entries from manifests, and derives subagents.allowAgents from
 * the tier/requires hierarchy.
 */
import type { AgentManifest } from "./zod-schema.agent-manifest.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal config agent entry — matches the shape in openclaw.json agents.list. */
export interface ConfigAgentEntry {
  id: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  agentDir?: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  skills?: string[];
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
  };
  subagents?: {
    allowAgents?: string[];
    model?: string | { primary?: string; fallbacks?: string[] };
    thinking?: string;
  };
  department?: string;
  role?: string;
  // Other runtime fields preserved as-is
  [key: string]: unknown;
}

export type DriftType =
  | "missing_config_entry"
  | "orphaned_config_entry"
  | "department_mismatch"
  | "role_mismatch"
  | "name_mismatch"
  | "allow_agents_stale"
  | "allow_agents_incomplete";

export interface DriftIssue {
  agentId: string;
  type: DriftType;
  message: string;
  expected?: string;
  actual?: string;
}

export interface DriftReport {
  issues: DriftIssue[];
  hasDrift: boolean;
  /** Agents in YAML but missing from config. */
  missingInConfig: string[];
  /** Agents in config but with no YAML manifest (excluding bundles). */
  orphanedInConfig: string[];
}

// ── Derive allowAgents from tier/requires ────────────────────────────────────

/**
 * Build a map of agentId → allowAgents[] from YAML tier/requires relationships.
 *
 * - T1 (core): can delegate to all T2 + all T3 agents
 * - T2 (dept heads): can delegate to T3 agents where requires === this T2 id
 * - T3 (specialists): no sub-delegation
 */
export function deriveAllowAgents(manifests: AgentManifest[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const nonBundles = manifests.filter((m) => !m.is_bundle);

  const t1Agents = nonBundles.filter((m) => m.tier === 1);
  const t2Agents = nonBundles.filter((m) => m.tier === 2);
  const t3Agents = nonBundles.filter((m) => m.tier === 3);

  // T2: collect their T3 children
  for (const t2 of t2Agents) {
    const children = t3Agents.filter((t3) => t3.requires === t2.id).map((t3) => t3.id);
    result.set(t2.id, children);
  }

  // T1: can reach all T2 and T3
  for (const t1 of t1Agents) {
    const allSubordinates = [...t2Agents.map((a) => a.id), ...t3Agents.map((a) => a.id)];
    result.set(t1.id, allSubordinates);
  }

  // T3: no sub-delegation
  for (const t3 of t3Agents) {
    result.set(t3.id, []);
  }

  return result;
}

// ── Build config entry from manifest ─────────────────────────────────────────

/**
 * Generate a config agent entry from a YAML manifest.
 * If an existing config entry is provided, runtime-only fields are preserved.
 */
export function buildConfigEntryFromManifest(
  manifest: AgentManifest,
  allowAgents: string[],
  existing?: ConfigAgentEntry,
): ConfigAgentEntry {
  const entry: ConfigAgentEntry = {
    // Preserve all existing runtime fields first
    ...existing,
    // Override with manifest values
    id: manifest.id,
    name: manifest.name,
    department: manifest.department,
    role: manifest.role,
  };

  // Identity: merge emoji/theme from manifest, preserve other identity fields
  if (manifest.identity || existing?.identity) {
    entry.identity = {
      ...existing?.identity,
      ...(manifest.identity?.emoji ? { emoji: manifest.identity.emoji } : {}),
      ...(manifest.identity?.theme ? { theme: manifest.identity.theme } : {}),
    };
  }

  // Subagents: set allowAgents from derived hierarchy
  if (allowAgents.length > 0) {
    entry.subagents = {
      ...existing?.subagents,
      allowAgents,
    };
  } else if (existing?.subagents) {
    // T3 agents: preserve existing subagents but clear allowAgents
    const { allowAgents: _removed, ...rest } = existing.subagents;
    if (Object.keys(rest).length > 0) {
      entry.subagents = rest as ConfigAgentEntry["subagents"];
    } else {
      delete entry.subagents;
    }
  }

  return entry;
}

// ── Detect drift ─────────────────────────────────────────────────────────────

/**
 * Compare YAML manifests against config agent entries and report drift.
 *
 * @param manifests - All loaded YAML manifests (non-bundle only)
 * @param configEntries - All entries from config agents.list
 * @param derivedAllowAgents - Pre-computed allowAgents map from deriveAllowAgents()
 */
export function detectDrift(
  manifests: AgentManifest[],
  configEntries: ConfigAgentEntry[],
  derivedAllowAgents: Map<string, string[]>,
): DriftReport {
  const issues: DriftIssue[] = [];
  const missingInConfig: string[] = [];
  const orphanedInConfig: string[] = [];

  const nonBundles = manifests.filter((m) => !m.is_bundle);
  const configById = new Map(configEntries.map((e) => [e.id, e]));
  const manifestById = new Map(nonBundles.map((m) => [m.id, m]));

  // Check each manifest has a config entry
  for (const manifest of nonBundles) {
    // The operator1 manifest maps to "main" in config
    const configId = manifest.id === "operator1" ? "main" : manifest.id;
    const configEntry = configById.get(configId);

    if (!configEntry) {
      missingInConfig.push(manifest.id);
      issues.push({
        agentId: manifest.id,
        type: "missing_config_entry",
        message: `Agent "${manifest.id}" has a YAML manifest but no config entry`,
      });
      continue;
    }

    // Check field matches
    if (configEntry.department && configEntry.department !== manifest.department) {
      issues.push({
        agentId: manifest.id,
        type: "department_mismatch",
        message: `Department mismatch: config="${configEntry.department}", manifest="${manifest.department}"`,
        expected: manifest.department,
        actual: configEntry.department,
      });
    }

    if (configEntry.role && configEntry.role !== manifest.role) {
      issues.push({
        agentId: manifest.id,
        type: "role_mismatch",
        message: `Role mismatch: config="${configEntry.role}", manifest="${manifest.role}"`,
        expected: manifest.role,
        actual: configEntry.role,
      });
    }

    if (configEntry.name && configEntry.name !== manifest.name) {
      issues.push({
        agentId: manifest.id,
        type: "name_mismatch",
        message: `Name mismatch: config="${configEntry.name}", manifest="${manifest.name}"`,
        expected: manifest.name,
        actual: configEntry.name,
      });
    }

    // Check allowAgents
    const expectedAllow = derivedAllowAgents.get(manifest.id) ?? [];
    const actualAllow = configEntry.subagents?.allowAgents ?? [];

    if (expectedAllow.length > 0) {
      // Map manifest IDs to config IDs for comparison (operator1 → main)
      const expectedConfigIds = expectedAllow
        .map((id) => (id === "operator1" ? "main" : id))
        .toSorted();
      const actualSorted = [...actualAllow].toSorted();

      // Check for missing agents in allowAgents
      const missingFromAllow = expectedConfigIds.filter((id) => !actualAllow.includes(id));
      if (missingFromAllow.length > 0) {
        issues.push({
          agentId: manifest.id,
          type: "allow_agents_incomplete",
          message: `Missing ${missingFromAllow.length} agent(s) from subagents.allowAgents: ${missingFromAllow.join(", ")}`,
          expected: expectedConfigIds.join(", "),
          actual: actualSorted.join(", "),
        });
      }
    }
  }

  // Check for orphaned config entries (in config but no manifest)
  // Skip "main" since it maps to "operator1"
  for (const entry of configEntries) {
    const manifestId = entry.id === "main" ? "operator1" : entry.id;
    if (!manifestById.has(manifestId)) {
      orphanedInConfig.push(entry.id);
      issues.push({
        agentId: entry.id,
        type: "orphaned_config_entry",
        message: `Config entry "${entry.id}" has no matching YAML manifest`,
      });
    }
  }

  return {
    issues,
    hasDrift: issues.length > 0,
    missingInConfig,
    orphanedInConfig,
  };
}

// ── Apply sync ───────────────────────────────────────────────────────────────

/**
 * Apply sync fixes to a config's agents.list based on drift report.
 * Returns the new agents list (does NOT write to disk).
 *
 * Only applies non-destructive fixes:
 * - Adds missing config entries from manifests
 * - Updates mismatched fields (department, role, name)
 * - Rebuilds allowAgents from tier/requires hierarchy
 *
 * Does NOT remove orphaned entries (that's a destructive operation
 * requiring explicit user confirmation via health.fix).
 */
export function applySync(
  manifests: AgentManifest[],
  configEntries: ConfigAgentEntry[],
  _driftReport: DriftReport,
): ConfigAgentEntry[] {
  const nonBundles = manifests.filter((m) => !m.is_bundle);
  const derivedAllow = deriveAllowAgents(nonBundles);
  const configById = new Map(configEntries.map((e) => [e.id, e]));
  const result = [...configEntries];

  for (const manifest of nonBundles) {
    const configId = manifest.id === "operator1" ? "main" : manifest.id;
    const existing = configById.get(configId);
    const allowAgents = derivedAllow.get(manifest.id) ?? [];
    // Map to config IDs
    const configAllowAgents = allowAgents.map((id) => (id === "operator1" ? "main" : id));

    if (!existing) {
      // Add missing entry
      const newEntry = buildConfigEntryFromManifest(manifest, configAllowAgents);
      // Use config ID (main instead of operator1)
      newEntry.id = configId;
      result.push(newEntry);
    } else {
      // Update existing entry
      const idx = result.findIndex((e) => e.id === configId);
      if (idx >= 0) {
        result[idx] = buildConfigEntryFromManifest(manifest, configAllowAgents, existing);
        result[idx].id = configId;
      }
    }
  }

  return result;
}
