// Load-time migration that preserves saved configurations with blank agent cwd
// values. A blank `cwd` (whitespace-only) was historically accepted: the
// runtime trimmed it and fell back to the default cwd. Once blank cwd is
// surfaced as a validation error, a saved blank would reject config loading
// entirely. This migration removes such blanks during load so existing
// installations keep loading and keep their effective (defaulted) cwd.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries } from "../agents/agent-roster.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankCwdMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankCwdFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.cwd)) {
    delete record.cwd;
    changes.push({ path, message: `Removed blank agents.${path}.cwd; the default cwd applies.` });
  }
}

// Write-path helper: remove blank cwd values that are NOT being explicitly set
// by this write. An unrelated `config set gateway.port` restores the authored
// roster (io.write-prepare restoreAuthoredAgentRoster), which can carry a saved
// blank cwd; strict write validation would otherwise reject the whole settings
// change. Explicitly-set paths (in explicitSetPaths) are preserved so new
// authoring still receives the field-level error. Explicit-set paths may be
// parents (e.g. `agents.entries.alpha` from an object edit) or the exact cwd
// leaf, so containment is a prefix match on the dotted path.
function isPreservedCwdPath(
  preservedCwdPaths: ReadonlySet<string> | undefined,
  cwdPath: string,
): boolean {
  if (!preservedCwdPaths) {
    return false;
  }
  for (const p of preservedCwdPaths) {
    if (cwdPath === p || cwdPath.startsWith(`${p}.`)) {
      return true;
    }
  }
  return false;
}

function migrateBlankAgentCwdRaw(
  raw: unknown,
  preservedCwdPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankCwdMigration {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  // structuredClone drops the retained-legacy-owner WeakMap association that
  // the preceding roster migration attached to the root config. Preserve it on
  // the cloned root so multi-agent configs with a legacy default marker keep
  // loading (AgentsSchema relies on the retained owner during validation).
  if (isRecord(raw)) {
    setRetainedLegacyDefaultAgentId(next, getRetainedLegacyDefaultAgentId(raw));
  }
  const agents = isRecord(next.agents) ? (next.agents as Record<string, unknown>) : {};
  const changes: ConfigValidationIssue[] = [];
  // A blank is a *saved* value (migrate it away so an unrelated settings write
  // is not blocked) only when it also exists as a blank in the saved source
  // config. A blank the current write newly introduced (not in the saved
  // source) must be preserved so strict validation reports the field error —
  // including metadata-free full-config writes, where explicitSetPaths cannot
  // distinguish new authoring from restored saved values. When no saved config
  // is supplied (load path) every blank is treated as saved.
  const savedBlankPaths =
    savedConfig === undefined ? undefined : indexSavedBlankCwdPaths(savedConfig);
  const migrateUnlessNew = (cwdPath: string): boolean =>
    !isPreservedCwdPath(preservedCwdPaths, cwdPath) &&
    (savedBlankPaths === undefined || savedBlankPaths.has(cwdPath));

  if (isRecord(agents.defaults) && isBlankString(agents.defaults.cwd)) {
    if (migrateUnlessNew("agents.defaults.cwd")) {
      delete agents.defaults.cwd;
      changes.push({ path: "agents.defaults.cwd", message: "Removed blank agents.defaults.cwd." });
    }
  }

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      const cwdPath = `agents.entries.${key}.cwd`;
      if (migrateUnlessNew(cwdPath)) {
        removeBlankCwdFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
      }
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      // The write owner records explicit paths by joining segments with dots
      // (`agents.list.0.cwd`); match that representation so an explicitly
      // written blank in a retained legacy list is preserved for validation.
      const cwdPath = `agents.list.${index}.cwd`;
      const savedPath =
        isRecord(entry) && typeof entry.id === "string"
          ? `agents.entries.${entry.id}.cwd`
          : undefined;
      const migrate =
        !isPreservedCwdPath(preservedCwdPaths, cwdPath) &&
        (savedBlankPaths === undefined ||
          (savedPath !== undefined && savedBlankPaths.has(savedPath)));
      if (migrate) {
        removeBlankCwdFromAgent(entry as Record<string, unknown>, `list.${index}`, changes);
      }
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

/** In-place removal shared with Doctor so recovery/doctor repair uses exactly
 * the same traversal and messages as the load/write migration: defaults, the
 * keyed entries map, and the legacy list form are all handled. */
export function applyBlankAgentCwdRemoval(raw: Record<string, unknown>, changes: string[]): void {
  const agents = isRecord(raw.agents) ? (raw.agents as Record<string, unknown>) : undefined;
  if (!agents) {
    return;
  }
  if (isRecord(agents.defaults) && isBlankString(agents.defaults.cwd)) {
    delete agents.defaults.cwd;
    changes.push("Removed blank agents.defaults.cwd.");
  }
  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      if (isRecord(entry) && isBlankString(entry.cwd)) {
        delete entry.cwd;
        changes.push(`Removed blank agents.entries.${key}.cwd; the default cwd applies.`);
      }
    }
  }
  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      if (isRecord(entry) && isBlankString(entry.cwd)) {
        delete entry.cwd;
        changes.push(`Removed blank agents.list[${index}].cwd; the default cwd applies.`);
      }
    }
  }
}

/** Index every agent cwd that is blank in the saved source config, normalized
 * across the legacy list and canonical entries roster forms, plus the defaults
 * cwd. Only these paths count as "saved blanks" for write-path migration. */
function indexSavedBlankCwdPaths(savedConfig: unknown): Set<string> {
  const set = new Set<string>();
  const agents = isRecord(savedConfig) ? (savedConfig as { agents?: unknown }).agents : undefined;
  if (!isRecord(agents)) {
    return set;
  }
  if (isRecord(agents.defaults) && isBlankString(agents.defaults.cwd)) {
    set.add("agents.defaults.cwd");
  }
  for (const entry of listAgentEntries(savedConfig as OpenClawConfig)) {
    if (isRecord(entry) && typeof entry.id === "string" && isBlankString(entry.cwd)) {
      set.add(`agents.entries.${entry.id}.cwd`);
    }
  }
  return set;
}

export function migrateBlankAgentCwd(raw: OpenClawConfig): BlankCwdMigration<OpenClawConfig>;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration {
  return migrateBlankAgentCwdRaw(raw);
}

/** Write-path variant: migrate saved blank cwd values but preserve the ones the
 * current write explicitly sets (so new authoring still gets the field error).
 * `savedConfig` is the pre-write source config; a blank that also exists there
 * is a saved value and can be migrated, while a blank the write newly
 * introduced is preserved for strict validation. */
export function migrateBlankAgentCwdForWrite(
  raw: OpenClawConfig,
  explicitSetPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankCwdMigration<OpenClawConfig>;
export function migrateBlankAgentCwdForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankCwdMigration;
export function migrateBlankAgentCwdForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankCwdMigration {
  return migrateBlankAgentCwdRaw(raw, explicitSetPaths, savedConfig);
}

/** Remap explicit legacy-list field paths (`agents.list.<N>.<field>`) to the
 * canonical entries form (`agents.entries.<id>.<field>`) using the authored
 * list ids. Canonical roster preparation converts an explicit list edit into
 * entries and filters roster paths from the injected explicit set, so without
 * this remap the write migration cannot tell that a converted blank was
 * explicitly authored and would silently migrate it away instead of letting
 * strict validation report the field error. */
export function remapLegacyListExplicitPaths(
  explicitSetPaths: readonly (readonly string[])[] | undefined,
  nextConfig: unknown,
): string[] {
  const agents = isRecord(nextConfig) ? nextConfig.agents : undefined;
  const list = isRecord(agents) && Array.isArray(agents.list) ? agents.list : undefined;
  if (!explicitSetPaths || !list) {
    return [];
  }
  const remapped: string[] = [];
  for (const path of explicitSetPaths) {
    if (path.length < 4 || path[0] !== "agents" || path[1] !== "list") {
      continue;
    }
    const index = Number(path[2]);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      continue;
    }
    const entry = list[index];
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    remapped.push(["agents", "entries", entry.id, ...path.slice(3)].join("."));
  }
  return remapped;
}
