// Load-time migration that preserves saved configurations with blank agent
// workspace values. A blank `workspace` (whitespace-only) was historically
// accepted: the runtime trimmed it and fell back to the default workspace
// directory. Once blank workspace is surfaced as a validation error, a saved
// blank would reject config loading entirely. This migration removes such
// blanks during load so existing installations keep loading and keep their
// effective (defaulted) workspace directory.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries } from "../agents/agent-roster.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type BlankWorkspaceMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && !value.trim();
}

function removeBlankWorkspaceFromAgent(
  record: Record<string, unknown>,
  path: string,
  changes: ConfigValidationIssue[],
): void {
  if (isRecord(record) && isBlankString(record.workspace)) {
    delete record.workspace;
    changes.push({
      path,
      message: `Removed blank agents.${path}.workspace; the default workspace directory applies.`,
    });
  }
}

// Write-path helper: preserve blank workspace values that the current write
// explicitly sets (or a parent of them), so new authoring still receives the
// field-level error. Explicit-set paths may be parents (e.g. `agents.entries.alpha`)
// or the exact leaf, so containment is a prefix match on the dotted path.
function isPreservedWorkspacePath(
  preservedWorkspacePaths: ReadonlySet<string> | undefined,
  workspacePath: string,
): boolean {
  if (!preservedWorkspacePaths) {
    return false;
  }
  for (const p of preservedWorkspacePaths) {
    if (workspacePath === p || workspacePath.startsWith(`${p}.`)) {
      return true;
    }
  }
  return false;
}

function migrateBlankAgentWorkspaceRaw(
  raw: unknown,
  preservedWorkspacePaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankWorkspaceMigration {
  if (!isRecord(raw) || !isRecord(raw.agents)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  // structuredClone drops the retained-legacy-owner WeakMap association that
  // the preceding roster migration attached to the config root. Preserve it on
  // the cloned root so multi-agent configs with a legacy default marker keep
  // loading (validation relies on the retained owner).
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
    savedConfig === undefined ? undefined : indexSavedBlankWorkspacePaths(savedConfig);
  const migrateUnlessNew = (workspacePath: string): boolean =>
    !isPreservedWorkspacePath(preservedWorkspacePaths, workspacePath) &&
    (savedBlankPaths === undefined || savedBlankPaths.has(workspacePath));

  if (isRecord(agents.defaults) && isBlankString(agents.defaults.workspace)) {
    if (migrateUnlessNew("agents.defaults.workspace")) {
      delete agents.defaults.workspace;
      changes.push({
        path: "agents.defaults.workspace",
        message: "Removed blank agents.defaults.workspace.",
      });
    }
  }

  if (isRecord(agents.entries)) {
    for (const [key, entry] of Object.entries(agents.entries)) {
      const workspacePath = `agents.entries.${key}.workspace`;
      if (migrateUnlessNew(workspacePath)) {
        removeBlankWorkspaceFromAgent(entry as Record<string, unknown>, `entries.${key}`, changes);
      }
    }
  }

  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      // The write owner records explicit paths by joining segments with dots
      // (`agents.list.0.workspace`); match that representation so an explicitly
      // written blank in a retained legacy list is preserved for validation.
      const workspacePath = `agents.list.${index}.workspace`;
      const savedPath =
        isRecord(entry) && typeof entry.id === "string"
          ? `agents.entries.${entry.id}.workspace`
          : undefined;
      const migrate =
        !isPreservedWorkspacePath(preservedWorkspacePaths, workspacePath) &&
        (savedBlankPaths === undefined ||
          (savedPath !== undefined && savedBlankPaths.has(savedPath)));
      if (migrate) {
        removeBlankWorkspaceFromAgent(entry as Record<string, unknown>, `list.${index}`, changes);
      }
    }
  }

  return changes.length > 0
    ? { config: next, changed: true, changes, warnings: [] }
    : { config: raw, changed: false, changes, warnings: [] };
}

/** Index every agent workspace that is blank in the saved source config,
 * normalized across the legacy list and canonical entries roster forms, plus
 * the defaults workspace. Only these paths count as "saved blanks" for
 * write-path migration. */
function indexSavedBlankWorkspacePaths(savedConfig: unknown): Set<string> {
  const set = new Set<string>();
  const agents = isRecord(savedConfig) ? (savedConfig as { agents?: unknown }).agents : undefined;
  if (!isRecord(agents)) {
    return set;
  }
  if (isRecord(agents.defaults) && isBlankString(agents.defaults.workspace)) {
    set.add("agents.defaults.workspace");
  }
  for (const entry of listAgentEntries(savedConfig as OpenClawConfig)) {
    if (isRecord(entry) && typeof entry.id === "string" && isBlankString(entry.workspace)) {
      set.add(`agents.entries.${entry.id}.workspace`);
    }
  }
  return set;
}

export function migrateBlankAgentWorkspace(
  raw: OpenClawConfig,
): BlankWorkspaceMigration<OpenClawConfig>;
export function migrateBlankAgentWorkspace(raw: unknown): BlankWorkspaceMigration;
export function migrateBlankAgentWorkspace(raw: unknown): BlankWorkspaceMigration {
  return migrateBlankAgentWorkspaceRaw(raw);
}

/** Write-path variant: migrate saved blank workspace values but preserve the
 * ones the current write explicitly sets (so new authoring still gets the
 * field error). `savedConfig` is the pre-write source config; a blank that
 * also exists there is a saved value and can be migrated, while a blank the
 * write newly introduced is preserved for strict validation. */
export function migrateBlankAgentWorkspaceForWrite(
  raw: OpenClawConfig,
  explicitSetPaths?: ReadonlySet<string>,
): BlankWorkspaceMigration<OpenClawConfig>;
export function migrateBlankAgentWorkspaceForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
): BlankWorkspaceMigration;
export function migrateBlankAgentWorkspaceForWrite(
  raw: unknown,
  explicitSetPaths?: ReadonlySet<string>,
  savedConfig?: unknown,
): BlankWorkspaceMigration {
  return migrateBlankAgentWorkspaceRaw(raw, explicitSetPaths, savedConfig);
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
