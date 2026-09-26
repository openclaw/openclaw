// Load-time migration that preserves saved configurations with blank agent cwd
// values. A blank `cwd` (whitespace-only) was historically accepted: the
// runtime trimmed it and fell back to the default cwd. Once blank cwd is
// surfaced as a validation error, a saved blank would reject config loading
// entirely. This migration removes such blanks during load so existing
// installations keep loading and keep their effective (defaulted) cwd.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

  if (isRecord(agents.defaults) && isBlankString(agents.defaults.cwd)) {
    if (!isPreservedCwdPath(preservedCwdPaths, "agents.defaults.cwd")) {
      delete agents.defaults.cwd;
      changes.push({ path: "agents.defaults.cwd", message: "Removed blank agents.defaults.cwd." });
    }
  }

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      const cwdPath = `agents.entries.${key}.cwd`;
      if (!isPreservedCwdPath(preservedCwdPaths, cwdPath)) {
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
      if (!isPreservedCwdPath(preservedCwdPaths, cwdPath)) {
        removeBlankCwdFromAgent(entry as Record<string, unknown>, `list.${index}`, changes);
      }
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

export function migrateBlankAgentCwd(raw: OpenClawConfig): BlankCwdMigration<OpenClawConfig>;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration;
export function migrateBlankAgentCwd(raw: unknown): BlankCwdMigration {
  return migrateBlankAgentCwdRaw(raw);
}

/** Write-path variant: migrate saved blank cwd values but preserve the ones the
 * current write explicitly sets (so new authoring still gets the field error). */
export function migrateBlankAgentCwdForWrite(
  raw: OpenClawConfig,
  explicitSetPaths?: ReadonlySet<string>,
): BlankCwdMigration<OpenClawConfig>;
export function migrateBlankAgentCwdForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
): BlankCwdMigration;
export function migrateBlankAgentCwdForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
): BlankCwdMigration {
  return migrateBlankAgentCwdRaw(raw, explicitSetPaths);
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
