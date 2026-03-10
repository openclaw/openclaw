/**
 * Agent manifest validation utilities.
 *
 * Validates agent.yaml manifests and AGENT.md files, enforces tier
 * dependencies, and checks permission escalation rules.
 */
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { AgentManifestSchema, type AgentManifest } from "./zod-schema.agent-manifest.js";

// ── AGENT.md validator ───────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n/;

/**
 * Validate that an AGENT.md file contains only prompt content (no YAML
 * frontmatter). All structured metadata must live in agent.yaml.
 */
export function validateAgentMd(content: string): { valid: boolean; error?: string } {
  if (FRONTMATTER_RE.test(content)) {
    return {
      valid: false,
      error:
        "AGENT.md must not contain YAML frontmatter (---). " +
        "All metadata belongs in agent.yaml; AGENT.md is prompt content only.",
    };
  }
  return { valid: true };
}

// ── agent.yaml validator ─────────────────────────────────────────────────────

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: AgentManifest;
  errors: string[];
}

/**
 * Parse and validate an agent.yaml file against the manifest schema.
 */
export function validateManifestYaml(yamlContent: string): ManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (err) {
    return { valid: false, errors: [`Invalid YAML: ${(err as Error).message}`] };
  }

  const result = AgentManifestSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { valid: false, errors };
  }

  return { valid: true, manifest: result.data, errors: [] };
}

// ── Tier enforcement ─────────────────────────────────────────────────────────

export interface TierValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate tier dependencies across a set of installed agents.
 *
 * Rules:
 * - Tier 1 (core): always present, cannot be removed
 * - Tier 2: can be installed independently
 * - Tier 3: requires parent Tier 2 agent to be installed
 */
export function validateTierDependencies(agents: AgentManifest[]): TierValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  for (const agent of agents) {
    if (agent.tier === 3 && agent.requires) {
      const parent = agentMap.get(agent.requires);
      if (!parent) {
        errors.push(
          `Agent "${agent.id}" (Tier 3) requires "${agent.requires}" which is not installed`,
        );
      } else if (parent.tier !== 2) {
        errors.push(
          `Agent "${agent.id}" requires "${agent.requires}" which is Tier ${parent.tier}, not Tier 2`,
        );
      }
    }

    if (agent.deprecated) {
      warnings.push(
        `Agent "${agent.id}" is deprecated` +
          (agent.sunset_date ? ` (sunset: ${agent.sunset_date})` : "") +
          (agent.replacement ? `. Replacement: ${agent.replacement}` : ""),
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check whether an agent can be safely removed without breaking dependents.
 * Returns the list of agents that depend on it.
 */
export function findDependents(agentId: string, agents: AgentManifest[]): AgentManifest[] {
  return agents.filter((a) => a.requires === agentId);
}

/**
 * Check whether installing an agent would satisfy its tier dependencies,
 * given the currently installed agents.
 */
export function canInstall(
  manifest: AgentManifest,
  installedAgents: AgentManifest[],
): { ok: boolean; missingDep?: string } {
  if (manifest.tier === 3 && manifest.requires) {
    const parentInstalled = installedAgents.some((a) => a.id === manifest.requires);
    if (!parentInstalled) {
      return { ok: false, missingDep: manifest.requires };
    }
  }
  return { ok: true };
}

// ── Permission escalation check (for extends) ───────────────────────────────

/**
 * Validate that a child agent does not escalate permissions beyond the
 * parent agent's tools.allow list. Child agents can only restrict, not expand.
 */
export function validatePermissionEscalation(
  child: AgentManifest,
  parent: AgentManifest,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const parentAllow = new Set(parent.tools?.allow ?? []);

  if (child.overrides?.tools?.allow) {
    for (const tool of child.overrides.tools.allow) {
      if (!parentAllow.has(tool)) {
        errors.push(
          `Child agent "${child.id}" cannot grant tool "${tool}" — parent "${parent.id}" does not allow it`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Load agent from directory ────────────────────────────────────────────────

export interface LoadAgentResult {
  manifest?: AgentManifest;
  promptContent?: string;
  errors: string[];
}

/**
 * Load and validate an agent from a directory containing agent.yaml and
 * optionally AGENT.md.
 */
export async function loadAgentFromDir(agentDir: string): Promise<LoadAgentResult> {
  const errors: string[] = [];

  // Load agent.yaml
  let yamlContent: string;
  try {
    yamlContent = await readFile(join(agentDir, "agent.yaml"), "utf-8");
  } catch {
    return { errors: [`Missing agent.yaml in ${basename(agentDir)}`] };
  }

  const yamlResult = validateManifestYaml(yamlContent);
  if (!yamlResult.valid) {
    return { errors: yamlResult.errors };
  }

  // Load AGENT.md (optional)
  let promptContent: string | undefined;
  try {
    const mdContent = await readFile(join(agentDir, "AGENT.md"), "utf-8");
    const mdResult = validateAgentMd(mdContent);
    if (!mdResult.valid) {
      errors.push(mdResult.error!);
    } else {
      promptContent = mdContent;
    }
  } catch {
    // AGENT.md is optional
  }

  return { manifest: yamlResult.manifest, promptContent, errors };
}
