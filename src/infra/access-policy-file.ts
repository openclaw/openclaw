import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import { validateAccessPolicyConfig } from "./access-policy.js";

export type AccessPolicyFile = {
  version: 1;
  /**
   * Per-agent overrides keyed by agent ID.
   *
   * Reserved key:
   *   "*" — base policy applied to every agent before the named agent block is merged in.
   *
   * Merge order (each layer wins over the previous):
   *   agents["*"] → agents[agentId]
   *
   * Within each layer:
   *   - policy:  shallow-merge, override key wins on collision
   *   - scripts: deep-merge per key; base sha256 is preserved
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
 * - rules:   shallow merge, override key wins
 * - scripts: deep-merge per key; base sha256 is preserved (cannot be removed by override)
 */
export function mergeAccessPolicy(
  base: AccessPolicyConfig | undefined,
  override: AccessPolicyConfig | undefined,
): AccessPolicyConfig | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    // Return a shallow copy so that validateAccessPolicyConfig → autoExpandBareDir
    // does not mutate the cached agents["*"] object in _fileCache. Without this,
    // the first call permanently corrupts policy entries for all subsequent calls
    // in the same process.
    // Deep-copy nested policy records so validateAccessPolicyConfig → autoExpandBareDir
    // cannot mutate the cached _fileCache object. Shallow-copying `scripts` is not enough:
    // `scripts["policy"]` (shared rules map) and per-script `entry.policy` maps are nested
    // objects that would still be references into the cache.
    const overrideScripts = override.scripts;
    const scriptsCopy: AccessPolicyConfig["scripts"] | undefined = overrideScripts
      ? Object.fromEntries(
          Object.entries(overrideScripts).map(([k, v]) => {
            if (k === "policy") {
              // scripts["policy"] is a Record<string, PermStr> — shallow copy is sufficient.
              return [k, v != null && typeof v === "object" ? { ...v } : v];
            }
            // Per-script entries: copy the entry and its nested policy map.
            if (v != null && typeof v === "object" && !Array.isArray(v)) {
              const entry = v as import("../config/types.tools.js").ScriptPolicyEntry;
              return [k, { ...entry, policy: entry.policy ? { ...entry.policy } : undefined }];
            }
            return [k, v];
          }),
        )
      : undefined;
    return {
      ...override,
      policy: override.policy ? { ...override.policy } : undefined,
      scripts: scriptsCopy,
    };
  }
  if (!override) {
    return base;
  }
  const rules = { ...base.policy, ...override.policy };
  // scripts: deep-merge per key — base sha256 is preserved regardless of
  // what the agent override supplies. A plain spread ({ ...base.scripts, ...override.scripts })
  // would silently drop the admin-configured hash integrity check when an agent block
  // supplies the same script key, defeating the security intent.
  const mergedScripts: NonNullable<AccessPolicyConfig["scripts"]> = { ...base.scripts };
  for (const [key, overrideEntry] of Object.entries(override.scripts ?? {})) {
    if (key === "policy") {
      // "policy" holds shared rules (Record<string, PermStr>) — merge as flat rules,
      // override key wins. No sha256 preservation applies here.
      mergedScripts["policy"] = { ...base.scripts?.["policy"], ...overrideEntry } as Record<
        string,
        string
      >;
      continue;
    }
    const baseEntry = base.scripts?.[key] as
      | import("../config/types.tools.js").ScriptPolicyEntry
      | undefined;
    // Reject non-object entries — a primitive (true, "rwx") is not a valid ScriptPolicyEntry.
    // validateAccessPolicyConfig also catches this, but the merge layer must not propagate it.
    if (
      overrideEntry == null ||
      typeof overrideEntry !== "object" ||
      Array.isArray(overrideEntry)
    ) {
      continue;
    }
    const overrideScriptEntry =
      overrideEntry as import("../config/types.tools.js").ScriptPolicyEntry;
    if (!baseEntry) {
      mergedScripts[key] = overrideScriptEntry;
      continue;
    }
    mergedScripts[key] = {
      // sha256: base always wins — cannot be removed or replaced by an agent override.
      ...(baseEntry.sha256 !== undefined ? { sha256: baseEntry.sha256 } : {}),
      // policy: shallow-merge, override key wins on collision.
      ...(Object.keys({ ...baseEntry.policy, ...overrideScriptEntry.policy }).length > 0
        ? { policy: { ...baseEntry.policy, ...overrideScriptEntry.policy } }
        : {}),
    };
  }
  const scripts = Object.keys(mergedScripts).length > 0 ? mergedScripts : undefined;
  const result: AccessPolicyConfig = {};
  if (Object.keys(rules).length > 0) {
    result.policy = rules;
  }
  if (scripts) {
    result.scripts = scripts;
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

  // Removed fields: "deny" and "default" were dropped in favour of "---" rules.
  // A user who configures these fields would receive no protection because the
  // fields are silently discarded. Reject them explicitly so the file fails-closed.
  const REMOVED_KEYS = ["deny", "default"] as const;

  function checkRemovedKeys(block: Record<string, unknown>, context: string): void {
    for (const key of REMOVED_KEYS) {
      if (block[key] !== undefined) {
        errors.push(
          `${filePath}: ${context} "${key}" is no longer supported — use "---" rules instead (e.g. "~/.ssh/**": "---"). Failing closed until removed.`,
        );
      }
    }
  }

  if (p["agents"] !== undefined) {
    if (typeof p["agents"] !== "object" || p["agents"] === null || Array.isArray(p["agents"])) {
      errors.push(`${filePath}: "agents" must be an object`);
    } else {
      for (const [agentId, block] of Object.entries(p["agents"] as Record<string, unknown>)) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) {
          errors.push(`${filePath}: agents["${agentId}"] must be an object`);
        } else {
          const agentBlock = block as Record<string, unknown>;
          checkRemovedKeys(agentBlock, `agents["${agentId}"]`);
          // Recurse into per-script entries so old "deny"/"default" fields are caught there too.
          const scripts = agentBlock["scripts"];
          if (scripts != null && typeof scripts === "object" && !Array.isArray(scripts)) {
            for (const [scriptKey, scriptEntry] of Object.entries(
              scripts as Record<string, unknown>,
            )) {
              if (scriptKey === "policy") {
                // scripts["policy"] must be an object (Record<string, PermStr>), not a primitive.
                if (
                  scriptEntry != null &&
                  (typeof scriptEntry !== "object" || Array.isArray(scriptEntry))
                ) {
                  errors.push(
                    `${filePath}: agents["${agentId}"].scripts["policy"] must be an object (Record<string, PermStr>), got ${JSON.stringify(scriptEntry)}`,
                  );
                }
              } else if (
                scriptEntry != null &&
                typeof scriptEntry === "object" &&
                !Array.isArray(scriptEntry)
              ) {
                checkRemovedKeys(
                  scriptEntry as Record<string, unknown>,
                  `agents["${agentId}"].scripts["${scriptKey}"]`,
                );
              }
            }
          }
        }
      }
    }
  }

  // Catch common mistakes: keys placed at the top level that belong inside agents["*"].
  // "base" and "policy" were old top-level fields; "rules"/"scripts" are often misplaced here too.
  for (const key of ["base", "policy", "rules", "scripts"] as const) {
    if (p[key] !== undefined) {
      errors.push(
        `${filePath}: unexpected top-level key "${key}" — did you mean to put it under agents["*"]?`,
      );
    }
  }

  return errors;
}

/**
 * Sentinel returned by loadAccessPolicyFile when the file exists but is broken.
 * Callers must treat this as a deny-all policy (default:"---") rather than
 * disabling enforcement — a corrupted file should fail-closed, not fail-open.
 */
export const BROKEN_POLICY_FILE = Symbol("broken-policy-file");

// In-process mtime cache — avoids re-parsing the file on every agent turn.
// Cache is keyed by mtime so any write to the file automatically invalidates it.
type _FileCacheEntry = {
  mtimeMs: number;
  result: AccessPolicyFile | typeof BROKEN_POLICY_FILE;
};
let _fileCache: _FileCacheEntry | undefined;

/** Reset the in-process file cache. Only for use in tests. */
export function _resetFileCacheForTest(): void {
  _fileCache = undefined;
}

/**
 * Read and parse the sidecar file.
 * - Returns null if the file does not exist (opt-in not configured).
 * - Returns BROKEN_POLICY_FILE if the file exists but is malformed/unreadable
 *   (callers must treat this as default:"---" — fail-closed).
 * - Returns the parsed file on success.
 *
 * Result is cached in-process by mtime — re-parses only when the file changes.
 */
export function loadAccessPolicyFile(): AccessPolicyFile | null | typeof BROKEN_POLICY_FILE {
  const filePath = resolveAccessPolicyPath();

  // Single statSync per call: cheap enough and detects file changes.
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // File does not exist — clear cache and return null (feature is opt-in).
    _fileCache = undefined;
    return null;
  }

  // Cache hit: same mtime means same content — skip readFileSync + JSON.parse.
  if (_fileCache && _fileCache.mtimeMs === mtimeMs) {
    return _fileCache.result;
  }

  // Cache miss: parse fresh and store result (including BROKEN_POLICY_FILE).
  const result = _parseAccessPolicyFile(filePath);
  _fileCache = { mtimeMs, result: result ?? BROKEN_POLICY_FILE };
  // _parseAccessPolicyFile returns null only for the non-existent case, which we
  // handle above via statSync. If it somehow returns null here treat as broken.
  return result ?? BROKEN_POLICY_FILE;
}

function _parseAccessPolicyFile(
  filePath: string,
): AccessPolicyFile | typeof BROKEN_POLICY_FILE | null {
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[access-policy] Cannot parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(`[access-policy] Failing closed (default: "---") until the file is fixed.`);
    return BROKEN_POLICY_FILE;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`[access-policy] ${filePath}: must be a JSON object at the top level.`);
    console.error(`[access-policy] Failing closed (default: "---") until the file is fixed.`);
    return BROKEN_POLICY_FILE;
  }

  const p = parsed as Record<string, unknown>;
  if (p["version"] !== 1) {
    console.error(
      `[access-policy] ${filePath}: unsupported version ${JSON.stringify(p["version"])} (expected 1).`,
    );
    console.error(`[access-policy] Failing closed (default: "---") until the file is fixed.`);
    return BROKEN_POLICY_FILE;
  }

  // Structural validation — catches wrong nesting, misplaced keys, etc.
  const structErrors = validateAccessPolicyFileStructure(filePath, parsed);
  if (structErrors.length > 0) {
    for (const err of structErrors) {
      console.error(`[access-policy] ${err}`);
    }
    console.error(`[access-policy] Failing closed (default: "---") until the file is fixed.`);
    return BROKEN_POLICY_FILE;
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
 * Merge order: agents["*"] → agents[agentId]
 *
 * Returns undefined when no sidecar file exists (no-op — all operations pass through).
 * Logs errors on invalid perm strings but does not throw — bad strings fall back to
 * deny-all for that entry (handled downstream by checkAccessPolicy's permAllows logic).
 */
/** Deny-all policy returned when the policy file is present but broken (fail-closed).
 * Empty rules + implicit "---" fallback = deny everything. */
const DENY_ALL_POLICY: AccessPolicyConfig = Object.freeze({});

export function resolveAccessPolicyForAgent(agentId?: string): AccessPolicyConfig | undefined {
  const file = loadAccessPolicyFile();
  if (file === BROKEN_POLICY_FILE) {
    // File exists but is malformed — fail-closed: deny everything until fixed.
    return DENY_ALL_POLICY;
  }
  if (!file) {
    // access-policy.json is entirely opt-in — silently return undefined when the
    // file is absent so users who have not configured the feature see no noise.
    return undefined;
  }

  // agents["*"] is the base — applies to every agent before the named block.
  let merged = mergeAccessPolicy(undefined, file.agents?.["*"]);
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
      if (errors.some((e) => !e.includes("auto-expanded") && !e.includes("mid-path wildcard"))) {
        console.error(
          `[access-policy] Bad permission strings are treated as "---" (deny all) at the tool layer and OS sandbox layer.`,
        );
      }
    }
  }

  return merged;
}
