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

type InteractiveMigrationSelection = { action: "select"; selectedItemIds: Set<string> };

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
      .map(
        params.kind === "skill"
          ? formatMigrationSkillSelectionLabel
          : formatMigrationPluginSelectionLabel,
      )
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

export function getSelectableMigrationSkillItems(plan: MigrationPlan): MigrationItem[] {
  return plan.items.filter(
    (item) =>
      item.kind === "skill" &&
      item.action === "copy" &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function getSelectableMigrationPluginItems(plan: MigrationPlan): MigrationItem[] {
  // Manual-review bundles and aggregate config writes are not install selections.
  return plan.items.filter(
    (item) =>
      item.kind === "plugin" &&
      item.action === "install" &&
      (item.status === "planned" || item.status === "conflict"),
  );
}

export function formatMigrationPluginSelectionLabel(item: MigrationItem): string {
  return normalizeOptionalString(item.details?.pluginName) ?? item.id.replace(/^plugin:/u, "");
}

export function getDefaultMigrationSelectionValues(items: readonly MigrationItem[]): string[] {
  return items.filter((item) => item.status === "planned").map((item) => item.id);
}

export function formatMigrationSkillSelectionLabel(item: MigrationItem): string {
  return normalizeOptionalString(item.details?.skillName) ?? item.id.replace(/^skill:/u, "");
}

function humanizeMigrationConflictReason(reason: string | undefined): string {
  return reason ? (MIGRATION_CONFLICT_REASON_PHRASES[reason] ?? reason) : "conflict";
}

export function formatMigrationSkillSelectionHint(item: MigrationItem): string | undefined {
  if (item.status !== "conflict") {
    return undefined;
  }
  const sourceLabel = normalizeOptionalString(item.details?.sourceLabel);
  const reason = humanizeMigrationConflictReason(item.reason);
  return sourceLabel ? `${sourceLabel} ${reason}` : reason;
}

export function formatMigrationPluginSelectionHint(item: MigrationItem): string | undefined {
  if (item.status !== "conflict") {
    return undefined;
  }
  const marketplace = normalizeOptionalString(item.details?.marketplaceName);
  const reason = humanizeMigrationConflictReason(item.reason);
  return marketplace ? `${marketplace} plugin ${reason}` : reason;
}

/** Keeps skill copies and their per-skill config patches inside the same selection. */
export function applyMigrationSelectedSkillItemIds(
  plan: MigrationPlan,
  selectedItemIds: ReadonlySet<string>,
): MigrationPlan {
  const selectable = getSelectableMigrationSkillItems(plan);
  const selectableIds = new Set(selectable.map((item) => item.id));
  const selectedSkillNames = new Set(
    selectable
      .filter((item) => selectedItemIds.has(item.id))
      .map(
        (item) =>
          normalizeOptionalString(item.details?.skillName) ??
          (item.source ? path.basename(item.source) : undefined),
      )
      .filter((name) => name !== undefined),
  );
  const items = plan.items.map((item) => {
    const configPath = item.kind === "config" ? item.details?.path : undefined;
    // Per-skill patches keep conflicts independent, so a deselected skill's
    // policy cannot mutate the target or block an otherwise valid import.
    if (
      Array.isArray(configPath) &&
      configPath.length === 3 &&
      configPath[0] === "skills" &&
      configPath[1] === "entries" &&
      !selectedSkillNames.has(configPath[2]) &&
      (item.status === "planned" || item.status === "conflict")
    ) {
      return markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON);
    }
    if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) {
      return item;
    }
    return markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON);
  });
  return {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
  };
}

/** Marks unselected plugin items skipped and filters matching Codex plugin config writes. */
export function applyMigrationSelectedPluginItemIds(
  plan: MigrationPlan,
  selectedItemIds: ReadonlySet<string>,
): MigrationPlan {
  const selectable = getSelectableMigrationPluginItems(plan);
  const selectableIds = new Set(selectable.map((item) => item.id));
  const selectedConfigKeys = new Set(
    selectable
      .filter((item) => selectedItemIds.has(item.id))
      .map((item) => normalizeOptionalString(item.details?.configKey))
      .filter((value): value is string => value !== undefined),
  );
  const items = plan.items.map((item) => {
    const selectedConfigItem = applyCodexPluginConfigSelection(item, selectedConfigKeys);
    if (selectedConfigItem) {
      return selectedConfigItem;
    }
    if (!selectableIds.has(item.id) || selectedItemIds.has(item.id)) {
      return item;
    }
    return markMigrationItemSkipped(item, MIGRATION_NOT_SELECTED_REASON);
  });
  return {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
  };
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
    const items =
      kind === "skill"
        ? getSelectableMigrationSkillItems(selectedPlan)
        : getSelectableMigrationPluginItems(selectedPlan);
    const selectedIds = resolveSelectedMigrationItemIds({ items, selectedRefs, kind });
    selectedPlan =
      kind === "skill"
        ? applyMigrationSelectedSkillItemIds(selectedPlan, selectedIds)
        : applyMigrationSelectedPluginItemIds(selectedPlan, selectedIds);
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
): InteractiveMigrationSelection {
  const selectableIds = new Set(items.map((item) => item.id));
  const selectedItemIds = new Set(selectedValues.filter((value) => selectableIds.has(value)));
  if (selectedItemIds.size > 0) {
    return { action: "select", selectedItemIds };
  }

  const selectedValueSet = new Set(selectedValues);
  if (selectedValueSet.has(MIGRATION_SELECTION_TOGGLE_ALL_OFF)) {
    return { action: "select", selectedItemIds: new Set() };
  }
  if (selectedValueSet.has(MIGRATION_SELECTION_TOGGLE_ALL_ON)) {
    return { action: "select", selectedItemIds: selectableIds };
  }

  return {
    action: "select",
    selectedItemIds,
  };
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
