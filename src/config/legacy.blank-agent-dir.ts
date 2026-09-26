// Load-time migration that preserves saved configurations with blank agent
// agentDir values. A blank `agentDir` (whitespace-only) was historically
// accepted: the runtime trimmed it and fell back to the default per-agent
// directory. Once blank agentDir is surfaced as a validation error, a saved
// blank would reject config loading entirely. This migration removes such
// blanks during load so existing installations keep loading and keep their
// effective (defaulted) agent directory.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries } from "../agents/agent-roster.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankAgentDirMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankAgentDirFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.agentDir)) {
    delete record.agentDir;
    changes.push({
      path,
      message: `Removed blank agents.${path}.agentDir; the default agent directory applies.`,
    });
  }
}

function isPreservedAgentDirPath(
  preservedAgentDirPaths: ReadonlySet<string> | undefined,
  agentDirPath: string,
): boolean {
  if (!preservedAgentDirPaths) {
    return false;
  }
  for (const p of preservedAgentDirPaths) {
    if (agentDirPath === p || agentDirPath.startsWith(`${p}.`)) {
      return true;
    }
  }
  return false;
}

function migrateBlankAgentDirRaw(
  raw: unknown,
  preservedAgentDirPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankAgentDirMigration {
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
    savedConfig === undefined ? undefined : indexSavedBlankAgentDirPaths(savedConfig);
  const migrateUnlessNew = (agentDirPath: string): boolean =>
    !isPreservedAgentDirPath(preservedAgentDirPaths, agentDirPath) &&
    (savedBlankPaths === undefined || savedBlankPaths.has(agentDirPath));

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      const agentDirPath = `agents.entries.${key}.agentDir`;
      if (migrateUnlessNew(agentDirPath)) {
        removeBlankAgentDirFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
      }
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      // Match the writer's explicit-set path representation (dot notation,
      // e.g. agents.list.0.agentDir) so prefix matching preserves a blank that
      // the current write itself sets.
      const agentDirPath = `agents.list.${index}.agentDir`;
      const savedPath =
        isRecord(entry) && typeof entry.id === "string"
          ? `agents.entries.${entry.id}.agentDir`
          : undefined;
      const migrate =
        !isPreservedAgentDirPath(preservedAgentDirPaths, agentDirPath) &&
        (savedBlankPaths === undefined ||
          (savedPath !== undefined && savedBlankPaths.has(savedPath)));
      if (migrate) {
        removeBlankAgentDirFromAgent(entry as Record<string, unknown>, `list.${index}`, changes);
      }
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

/** In-place removal shared with Doctor so recovery/doctor repair uses exactly
 * the same traversal and messages as the load/write migration: the keyed
 * entries map and the legacy list form are both handled. */
export function applyBlankAgentDirRemoval(raw: Record<string, unknown>, changes: string[]): void {
  const agents = isRecord(raw.agents) ? (raw.agents as Record<string, unknown>) : undefined;
  if (!agents) {
    return;
  }
  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      if (isRecord(entry) && isBlankString(entry.agentDir)) {
        delete entry.agentDir;
        changes.push(
          `Removed blank agents.entries.${key}.agentDir; the default agent directory applies.`,
        );
      }
    }
  }
  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      if (isRecord(entry) && isBlankString(entry.agentDir)) {
        delete entry.agentDir;
        changes.push(
          `Removed blank agents.list[${index}].agentDir; the default agent directory applies.`,
        );
      }
    }
  }
}

/** Index every agent agentDir that is blank in the saved source config,
 * normalized across the legacy list and canonical entries roster forms. Only
 * these paths count as "saved blanks" for write-path migration. */
function indexSavedBlankAgentDirPaths(savedConfig: unknown): Set<string> {
  const set = new Set<string>();
  for (const entry of listAgentEntries(savedConfig as OpenClawConfig)) {
    if (isRecord(entry) && typeof entry.id === "string" && isBlankString(entry.agentDir)) {
      set.add(`agents.entries.${entry.id}.agentDir`);
    }
  }
  return set;
}

export function migrateBlankAgentDir(raw: OpenClawConfig): BlankAgentDirMigration<OpenClawConfig>;
export function migrateBlankAgentDir(raw: unknown): BlankAgentDirMigration;
export function migrateBlankAgentDir(raw: unknown): BlankAgentDirMigration {
  return migrateBlankAgentDirRaw(raw);
}

/** Write-path variant: migrate saved blank agentDir values but preserve the ones
 * the current write explicitly sets (so new authoring still gets the field
 * error). `savedConfig` is the pre-write source config; a blank that also
 * exists there is a saved value and can be migrated, while a blank the write
 * newly introduced is preserved for strict validation. */
export function migrateBlankAgentDirForWrite(
  raw: OpenClawConfig,
  explicitSetPaths?: ReadonlySet<string>,
): BlankAgentDirMigration<OpenClawConfig>;
export function migrateBlankAgentDirForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
): BlankAgentDirMigration;
export function migrateBlankAgentDirForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankAgentDirMigration {
  return migrateBlankAgentDirRaw(raw, explicitSetPaths, savedConfig);
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
