import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { markMigrationItemSkipped, summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { applyMigrationItemSelection } from "./item-selection.js";
import { MIGRATION_CONFLICT_REASON_PHRASES } from "./output.js";
import type { MigrateCommonOptions } from "./types.js";

const MIGRATION_NOT_SELECTED_REASON = "not selected for migration";
export const MIGRATION_SELECTION_ACCEPT = "__openclaw_migrate_accept_recommended__";
export const MIGRATION_SELECTION_TOGGLE_ALL_ON = "__openclaw_migrate_toggle_all_on__";
export const MIGRATION_SELECTION_TOGGLE_ALL_OFF = "__openclaw_migrate_toggle_all_off__";

type MigrationSelectionKind = "skill" | "plugin";

function migrationItemRefs(item: MigrationItem, kind: "skill" | "plugin"): string[] {
  const prefix = `${kind}:`;
  const idSuffix = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : undefined;
  const sourceBase = item.source ? path.basename(item.source) : undefined;
  const targetBase = item.target ? path.basename(item.target) : undefined;
  return [
    item.id,
    idSuffix,
    normalizeOptionalString(item.details?.[`${kind}Name`]),
    ...(kind === "plugin" ? [normalizeOptionalString(item.details?.configKey)] : []),
    sourceBase,
    targetBase,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function formatSelectionRefList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `"${value}"`).join(", ");
}

function buildSelectionIndex(
  items: readonly MigrationItem[],
  kind: "skill" | "plugin",
): Map<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const item of items) {
    for (const ref of migrationItemRefs(item, kind)) {
      const normalized = normalizeOptionalLowercaseString(ref);
      if (!normalized) {
        continue;
      }
      const existing = index.get(normalized) ?? new Set<string>();
      existing.add(item.id);
      index.set(normalized, existing);
    }
  }
  return index;
}

function resolveSelectedMigrationItemIds(params: {
  items: readonly MigrationItem[];
  selectedRefs: readonly string[];
  kind: "skill" | "plugin";
}): Set<string> {
  const index = buildSelectionIndex(params.items, params.kind);
  const selectedIds = new Set<string>();
  const unknownRefs: string[] = [];
  const ambiguousRefs: string[] = [];
  for (const ref of params.selectedRefs) {
    const normalized = normalizeOptionalLowercaseString(ref);
    if (!normalized) {
      continue;
    }
    const matches = index.get(normalized);
    if (!matches) {
      unknownRefs.push(ref);
      continue;
    }
    if (matches.size > 1) {
      ambiguousRefs.push(ref);
      continue;
    }
    const [id] = matches;
    if (id) {
      selectedIds.add(id);
    }
  }

  if (unknownRefs.length > 0 || ambiguousRefs.length > 0) {
    const available = params.items
      .map((item) => formatMigrationSelectionLabel(item, params.kind))
      .toSorted((a, b) => a.localeCompare(b));
    const titleKind = params.kind === "skill" ? "Skill" : "Plugin";
    const parts: string[] = [];
    if (unknownRefs.length > 0) {
      parts.push(`No migratable ${params.kind} matched ${formatSelectionRefList(unknownRefs)}.`);
    }
    if (ambiguousRefs.length > 0) {
      parts.push(`${titleKind} selection ${formatSelectionRefList(ambiguousRefs)} was ambiguous.`);
    }
    parts.push(
      `Available ${params.kind}s: ${available.length > 0 ? available.join(", ") : "none"}.`,
    );
    throw new Error(parts.join(" "));
  }

  return selectedIds;
}

export function getSelectableMigrationItems(
  plan: MigrationPlan,
  kind: MigrationSelectionKind,
): MigrationItem[] {
  // Manual-review bundles and aggregate config writes are not install selections.
  return plan.items.filter(
    (item) =>
      item.kind === kind &&
      item.action === (kind === "skill" ? "copy" : "install") &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function formatMigrationSelectionLabel(
  item: MigrationItem,
  kind: MigrationSelectionKind,
): string {
  const prefix = `${kind}:`;
  return (
    normalizeOptionalString(item.details?.[`${kind}Name`]) ??
    (item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id)
  );
}

export function getDefaultMigrationSelectionValues(items: readonly MigrationItem[]): string[] {
  return items.filter((item) => item.status === "planned").map((item) => item.id);
}

export function formatMigrationSelectionHint(
  item: MigrationItem,
  kind: MigrationSelectionKind,
): string | undefined {
  if (item.status !== "conflict") {
    return undefined;
  }
  const label = normalizeOptionalString(
    item.details?.[kind === "skill" ? "sourceLabel" : "marketplaceName"],
  );
  const reason = item.reason
    ? (MIGRATION_CONFLICT_REASON_PHRASES[item.reason] ?? item.reason)
    : "conflict";
  return label ? `${label}${kind === "plugin" ? " plugin" : ""} ${reason}` : reason;
}

/** Keep selected copies/installs and their corresponding config writes together. */
export function applyMigrationSelectedItemIds(
  plan: MigrationPlan,
  selectedItemIds: ReadonlySet<string>,
  kind: MigrationSelectionKind,
): MigrationPlan {
  const selectable = getSelectableMigrationItems(plan, kind);
  const selectableIds = new Set(selectable.map((item) => item.id));
  const selectedConfigKeys = new Set(
    selectable
      .filter((item) => selectedItemIds.has(item.id))
      .map((item) =>
        kind === "plugin"
          ? normalizeOptionalString(item.details?.configKey)
          : (normalizeOptionalString(item.details?.skillName) ??
            (item.source ? path.basename(item.source) : undefined)),
      )
      .filter((name) => name !== undefined),
  );
  const items = plan.items.map((item) => {
    if (kind === "plugin") {
      const selectedConfigItem = applyCodexPluginConfigSelection(item, selectedConfigKeys);
      if (selectedConfigItem) {
        return selectedConfigItem;
      }
    } else {
      const configPath = item.kind === "config" ? item.details?.path : undefined;
      // A deselected skill's policy cannot mutate the target or block another import.
      if (
        Array.isArray(configPath) &&
        configPath.length === 3 &&
        configPath[0] === "skills" &&
        configPath[1] === "entries" &&
        !selectedConfigKeys.has(configPath[2]) &&
        (item.status === "planned" || item.status === "conflict")
      ) {
        return markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON);
      }
    }
    return selectableIds.has(item.id) && !selectedItemIds.has(item.id)
      ? markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON)
      : item;
  });
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}

export function applyMigrationSelections(
  plan: MigrationPlan,
  opts: MigrateCommonOptions,
): MigrationPlan {
  let selectedPlan = plan;
  for (const kind of ["skill", "plugin"] as const) {
    const selectedRefs = opts[`${kind}s`];
    if (selectedRefs === undefined) {
      continue;
    }
    const items = getSelectableMigrationItems(selectedPlan, kind);
    const selectedIds = resolveSelectedMigrationItemIds({ items, selectedRefs, kind });
    selectedPlan = applyMigrationSelectedItemIds(selectedPlan, selectedIds, kind);
  }
  return applyMigrationItemSelection(selectedPlan, opts.itemIds);
}

function applyCodexPluginConfigSelection(
  item: MigrationItem,
  selectedConfigKeys: ReadonlySet<string>,
): MigrationItem | undefined {
  // Nonmatching config shapes still pass through ordinary item-id selection.
  if (item.kind !== "config" || item.action !== "merge") {
    return undefined;
  }
  const value = item.details?.value;
  if (!isRecord(value)) {
    return undefined;
  }
  const config = value.config;
  if (!isRecord(config)) {
    return undefined;
  }
  const codexPlugins = config.codexPlugins;
  if (!isRecord(codexPlugins) || !isRecord(codexPlugins.plugins)) {
    return undefined;
  }
  const plugins = Object.fromEntries(
    Object.entries(codexPlugins.plugins).filter(([configKey]) => selectedConfigKeys.has(configKey)),
  );
  if (Object.keys(plugins).length === 0) {
    return markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON);
  }
  return {
    ...item,
    details: {
      ...item.details,
      value: {
        ...value,
        config: {
          ...config,
          codexPlugins: {
            ...codexPlugins,
            plugins,
          },
        },
      },
    },
  };
}

export function resolveInteractiveMigrationSelection(
  items: readonly MigrationItem[],
  selectedValues: readonly string[],
): Set<string> {
  const selectableIds = new Set(items.map((item) => item.id));
  const selectedItemIds = new Set(selectedValues.filter((value) => selectableIds.has(value)));
  return selectedItemIds.size === 0 &&
    !selectedValues.includes(MIGRATION_SELECTION_TOGGLE_ALL_OFF) &&
    selectedValues.includes(MIGRATION_SELECTION_TOGGLE_ALL_ON)
    ? selectableIds
    : selectedItemIds;
}

function isMigrationSelectionToggleValue(value: string): boolean {
  return (
    value === MIGRATION_SELECTION_TOGGLE_ALL_ON || value === MIGRATION_SELECTION_TOGGLE_ALL_OFF
  );
}

function selectedMigrationItemValues(selectedValues: readonly string[]): string[] {
  return selectedValues.filter((value) => !isMigrationSelectionToggleValue(value));
}

function resolveMigrationSelectionBulkToggleValues(
  activatedValue: string | undefined,
  selectableValues: readonly string[],
): string[] | undefined {
  if (activatedValue === MIGRATION_SELECTION_TOGGLE_ALL_ON) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
  }
  if (activatedValue === MIGRATION_SELECTION_TOGGLE_ALL_OFF) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }
  return undefined;
}

export function reconcileInteractiveMigrationSkillToggleValues(
  selectedValues: readonly string[],
  activatedValue: string | undefined,
  selectableValues: readonly string[],
): string[] {
  const bulkValues = resolveMigrationSelectionBulkToggleValues(activatedValue, selectableValues);
  if (bulkValues !== undefined) {
    return bulkValues;
  }
  if (activatedValue !== undefined && selectableValues.includes(activatedValue)) {
    return selectedMigrationItemValues(selectedValues);
  }
  return selectedValues.filter(
    (value) =>
      value !== MIGRATION_SELECTION_TOGGLE_ALL_ON ||
      !selectedValues.includes(MIGRATION_SELECTION_TOGGLE_ALL_OFF),
  );
}

export function reconcileInteractiveMigrationEnterValues(
  selectedValues: readonly string[],
  activatedValue: string | undefined,
  selectableValues: readonly string[],
  opts: { preserveDeselectedActivatedValue?: boolean } = {},
): string[] {
  const bulkValues = resolveMigrationSelectionBulkToggleValues(activatedValue, selectableValues);
  if (bulkValues !== undefined) {
    return bulkValues;
  }
  if (activatedValue !== undefined && selectableValues.includes(activatedValue)) {
    const selectedSelectableValues = selectedMigrationItemValues(selectedValues);
    if (opts.preserveDeselectedActivatedValue && !selectedValues.includes(activatedValue)) {
      return selectedSelectableValues;
    }
    return uniqueStrings([...selectedSelectableValues, activatedValue]);
  }
  return [...selectedValues];
}

export function reconcileInteractiveMigrationShortcutValues(
  previousValues: readonly string[],
  selectedValues: readonly string[],
  selectableValues: readonly string[],
  key: "a" | "i",
): string[] {
  const previousSelectable = previousValues.filter((value) => selectableValues.includes(value));
  if (key === "a" && previousSelectable.length === selectableValues.length) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }

  const selectedSelectable = selectedValues.filter((value) => selectableValues.includes(value));
  if (selectedSelectable.length === selectableValues.length) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_ON, ...selectableValues];
  }
  if (selectedSelectable.length === 0) {
    return [MIGRATION_SELECTION_TOGGLE_ALL_OFF];
  }
  return selectedSelectable;
}
