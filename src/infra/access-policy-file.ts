import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import { validateAccessPolicyConfig } from "./access-policy.js";

export type AccessPolicyFile = {
  version: 1;
  base?: AccessPolicyConfig;
  /**
   * Per-agent overrides keyed by agent ID, or "*" for a wildcard that applies
   * to every agent before the named agent block is merged in.
   *
   * Merge order (each layer wins over the previous):
   *   base → agents["*"] → agents[agentId]
   *
   * Within each layer:
   *   - deny:    additive (concat) — a base deny entry can never be removed by an override
   *   - rules:   shallow-merge, override key wins on collision
   *   - default: override wins if set
   */
  agents?: Record<string, AccessPolicyConfig>;
};

// Use os.homedir() directly — NOT expandHomePrefix — so that OPENCLAW_HOME
// (which points at ~/.openclaw, the data dir) does not produce a double-nested
// path like ~/.openclaw/.openclaw/access-policy.json.
export function resolveAccessPolicyPath(): string {
  return path.join(os.homedir(), ".openclaw", "access-policy.json");
}

/**
 * Merge two AccessPolicyConfig layers.
 * - deny:    additive (cannot remove a base deny)
 * - rules:   shallow merge, override key wins
 * - default: override wins if set
 */
export function mergeAccessPolicy(
  base: AccessPolicyConfig | undefined,
  override: AccessPolicyConfig | undefined,
): AccessPolicyConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  const deny = [...(base.deny ?? []), ...(override.deny ?? [])];
  const rules = { ...base.rules, ...override.rules };
  // scripts: shallow merge — override key wins (same semantics as rules)
  const scripts = { ...base.scripts, ...override.scripts };
  const result: AccessPolicyConfig = {};
  if (deny.length > 0) {
    result.deny = deny;
  }
  if (Object.keys(rules).length > 0) {
    result.rules = rules;
  }
  if (Object.keys(scripts).length > 0) {
    result.scripts = scripts;
  }
  if (override.default !== undefined) {
    result.default = override.default;
  } else if (base.default !== undefined) {
    result.default = base.default;
  }
  return result;
}

/**
 * Validate the top-level structure of a parsed access-policy file.
 * Returns an array of error strings; empty = valid.
 */
function validateAccessPolicyFileStructure(filePath: string, parsed: unknown): string[] {
  const errors: string[] = [];
  const p = parsed as Record<string, unknown>;

  if (
    p["base"] !== undefined &&
    (typeof p["base"] !== "object" || p["base"] === null || Array.isArray(p["base"]))
  ) {
    errors.push(`${filePath}: "base" must be an object`);
  }
  if (p["agents"] !== undefined) {
    if (typeof p["agents"] !== "object" || p["agents"] === null || Array.isArray(p["agents"])) {
      errors.push(`${filePath}: "agents" must be an object`);
    } else {
      for (const [agentId, block] of Object.entries(p["agents"] as Record<string, unknown>)) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) {
          errors.push(`${filePath}: agents["${agentId}"] must be an object`);
        }
      }
    }
  }

  // Catch common mistake: AccessPolicyConfig fields accidentally at top level
  // (e.g. user puts "rules" or "deny" directly instead of under "base").
  for (const key of ["rules", "deny", "default", "scripts"] as const) {
    if (p[key] !== undefined) {
      errors.push(
        `${filePath}: unexpected top-level key "${key}" — did you mean to put it under "base"?`,
      );
    }
  }

  return errors;
}

/**
 * Read and parse the sidecar file. Returns null if the file does not exist.
 * Logs a clear error (and returns null) if the file is present but broken.
 */
export function loadAccessPolicyFile(): AccessPolicyFile | null {
  const filePath = resolveAccessPolicyPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[access-policy] Cannot parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`[access-policy] Permissions enforcement is DISABLED until the file is fixed.`);
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`[access-policy] ${filePath}: must be a JSON object at the top level.`);
    console.error(`[access-policy] Permissions enforcement is DISABLED until the file is fixed.`);
    return null;
  }

  const p = parsed as Record<string, unknown>;
  if (p["version"] !== 1) {
    console.error(
      `[access-policy] ${filePath}: unsupported version ${JSON.stringify(p["version"])} (expected 1).`,
    );
    console.error(`[access-policy] Permissions enforcement is DISABLED until the file is fixed.`);
    return null;
  }

  // Structural validation — catches wrong nesting, misplaced keys, etc.
  const structErrors = validateAccessPolicyFileStructure(filePath, parsed);
  if (structErrors.length > 0) {
    for (const err of structErrors) {
      console.error(`[access-policy] ${err}`);
    }
    console.error(`[access-policy] Permissions enforcement is DISABLED until the file is fixed.`);
    return null;
  }

  return parsed as AccessPolicyFile;
}

// Suppress repeated validation error spam — resolveAccessPolicyForAgent is called
// on every agent turn; a single bad perm string would otherwise flood stderr.
// Keyed by agentId (or "__default__") so each agent's errors are shown once,
// rather than a global flag that silently swallows errors for all agents after the first.
const _validationErrorsWarnedFor = new Set<string>();

/** Reset the one-time warning flags. Only for use in tests. */
export function _resetNotFoundWarnedForTest(): void {
  _validationErrorsWarnedFor.clear();
}

/**
 * Resolve the effective AccessPolicyConfig for a given agent.
 *
 * Merge order: base → agents["*"] → agents[agentId]
 *
 * Returns undefined when no sidecar file exists (no-op — all operations pass through).
 * Logs errors on invalid perm strings but does not throw — bad strings fall back to
 * deny-all for that entry (handled downstream by checkAccessPolicy's permAllows logic).
 */
export function resolveAccessPolicyForAgent(agentId?: string): AccessPolicyConfig | undefined {
  const file = loadAccessPolicyFile();
  if (!file) {
    // access-policy.json is entirely opt-in — silently return undefined when the
    // file is absent so users who have not configured the feature see no noise.
    return undefined;
  }

  let merged = mergeAccessPolicy(undefined, file.base);
  const wildcard = file.agents?.["*"];
  if (wildcard) {
    merged = mergeAccessPolicy(merged, wildcard);
  }
  if (agentId && agentId !== "*") {
    const agentBlock = file.agents?.[agentId];
    if (agentBlock) {
      merged = mergeAccessPolicy(merged, agentBlock);
    }
  }

  if (merged) {
    const errors = validateAccessPolicyConfig(merged);
    const dedupeKey = agentId ?? "__default__";
    if (errors.length > 0 && !_validationErrorsWarnedFor.has(dedupeKey)) {
      _validationErrorsWarnedFor.add(dedupeKey);
      const filePath = resolveAccessPolicyPath();
      for (const err of errors) {
        console.error(`[access-policy] ${filePath}: ${err}`);
      }
      // Only print the footer when there are real permission-string errors —
      // auto-expand diagnostics ("rule auto-expanded to ...") are informational
      // and the footer would mislead operators into thinking the policy is broken.
      if (errors.some((e) => !e.includes("auto-expanded"))) {
        console.error(`[access-policy] Bad permission strings are treated as "---" (deny all).`);
      }
    }
  }

  return merged;
}
