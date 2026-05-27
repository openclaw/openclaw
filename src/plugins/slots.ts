import type { OpenClawConfig } from "../config/types.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import type { PluginKind } from "./plugin-kind.types.js";

export type PluginSlotKey = keyof PluginSlotsConfig;
export type ExclusivePluginSlotKey = "memory.recall" | "contextEngine";

export const MEMORY_PLUGIN_SLOT_KEYS = [
  "memory",
  "memory.recall",
  "memory.compaction",
  "memory.capture",
  "memory.dreaming",
  "memory.userModel",
] as const satisfies readonly PluginSlotKey[];

export const PLUGIN_SLOT_KEYS = [
  ...MEMORY_PLUGIN_SLOT_KEYS,
  "contextEngine",
] as const satisfies readonly PluginSlotKey[];

type SlotPluginRecord = {
  id: string;
  kind?: PluginKind | PluginKind[];
};

const SLOT_BY_KIND: Record<PluginKind, ExclusivePluginSlotKey> = {
  memory: "memory.recall",
  "context-engine": "contextEngine",
};

const DEFAULT_SLOT_BY_KEY: Record<PluginSlotKey, string> = {
  memory: "memory-core",
  "memory.recall": "memory-core",
  "memory.compaction": "none",
  "memory.capture": "none",
  "memory.dreaming": "none",
  "memory.userModel": "none",
  contextEngine: "legacy",
};

/** Normalize a kind field to an array for uniform iteration. */
export function normalizeKinds(kind?: PluginKind | PluginKind[]): PluginKind[] {
  if (!kind) {
    return [];
  }
  return Array.isArray(kind) ? kind : [kind];
}

/** Check whether a plugin's kind field includes a specific kind. */
export function hasKind(kind: PluginKind | PluginKind[] | undefined, target: PluginKind): boolean {
  if (!kind) {
    return false;
  }
  return Array.isArray(kind) ? kind.includes(target) : kind === target;
}

/** Order-insensitive equality check for two kind values (string or array). */
export function kindsEqual(
  a: PluginKind | PluginKind[] | undefined,
  b: PluginKind | PluginKind[] | undefined,
): boolean {
  const aN = normalizeKinds(a).toSorted();
  const bN = normalizeKinds(b).toSorted();
  return aN.length === bN.length && aN.every((k, i) => k === bN[i]);
}

/** Return all slot keys that a plugin's kind field maps to. */
export function slotKeysForPluginKind(kind?: PluginKind | PluginKind[]): ExclusivePluginSlotKey[] {
  return normalizeKinds(kind)
    .map((k) => SLOT_BY_KIND[k])
    .filter((k): k is ExclusivePluginSlotKey => k != null);
}

export function defaultSlotIdForKey(slotKey: PluginSlotKey): string {
  return DEFAULT_SLOT_BY_KEY[slotKey];
}

export function resetPluginSlotReferences<
  T extends Partial<Record<PluginSlotKey, string | undefined>>,
>(
  slots: T | undefined,
  pluginId: string,
  slotKeys: readonly PluginSlotKey[] = PLUGIN_SLOT_KEYS,
): { slots: T | undefined; changed: boolean; resetKeys: PluginSlotKey[] } {
  if (!slots) {
    return { slots, changed: false, resetKeys: [] };
  }
  let next: T | undefined;
  const resetKeys: PluginSlotKey[] = [];
  for (const slotKey of slotKeys) {
    if (slots[slotKey] !== pluginId) {
      continue;
    }
    next ??= { ...slots };
    Object.assign(next, { [slotKey]: defaultSlotIdForKey(slotKey) });
    resetKeys.push(slotKey);
  }
  return { slots: next ?? slots, changed: resetKeys.length > 0, resetKeys };
}

export type SlotSelectionResult = {
  config: OpenClawConfig;
  warnings: string[];
  changed: boolean;
};

export function applyExclusiveSlotSelection(params: {
  config: OpenClawConfig;
  selectedId: string;
  selectedKind?: PluginKind | PluginKind[];
  registry?: { plugins: SlotPluginRecord[] };
}): SlotSelectionResult {
  const slotKeys = slotKeysForPluginKind(params.selectedKind);
  if (slotKeys.length === 0) {
    return { config: params.config, warnings: [], changed: false };
  }

  const warnings: string[] = [];
  const pluginsConfig = params.config.plugins ?? {};
  let anyChanged = false;
  const entries = { ...pluginsConfig.entries };
  const slots = { ...pluginsConfig.slots };

  for (const slotKey of slotKeys) {
    const prevSlot = slots[slotKey];
    slots[slotKey] = params.selectedId;

    const inferredPrevSlot = prevSlot ?? defaultSlotIdForKey(slotKey);
    if (inferredPrevSlot && inferredPrevSlot !== params.selectedId) {
      warnings.push(
        `Exclusive slot "${slotKey}" switched from "${inferredPrevSlot}" to "${params.selectedId}".`,
      );
    }

    const disabledIds: string[] = [];
    if (params.registry) {
      for (const plugin of params.registry.plugins) {
        if (plugin.id === params.selectedId) {
          continue;
        }
        const kindForSlot = (Object.keys(SLOT_BY_KIND) as PluginKind[]).find(
          (k) => SLOT_BY_KIND[k] === slotKey,
        );
        if (!kindForSlot || !hasKind(plugin.kind, kindForSlot)) {
          continue;
        }
        // Don't disable a plugin that still owns another slot (explicit or default).
        const stillOwnsOtherSlot = (Object.keys(SLOT_BY_KIND) as PluginKind[])
          .map((k) => SLOT_BY_KIND[k])
          .filter((sk) => sk !== slotKey)
          .some((sk) => (slots[sk] ?? defaultSlotIdForKey(sk)) === plugin.id);
        if (stillOwnsOtherSlot) {
          continue;
        }
        const entry = entries[plugin.id];
        if (!entry || entry.enabled !== false) {
          entries[plugin.id] = { ...entry, enabled: false };
          disabledIds.push(plugin.id);
        }
      }
    }

    if (disabledIds.length > 0) {
      warnings.push(
        `Disabled other "${slotKey}" slot plugins: ${disabledIds.toSorted().join(", ")}.`,
      );
    }

    if (prevSlot !== params.selectedId || disabledIds.length > 0) {
      anyChanged = true;
    }
  }

  if (!anyChanged) {
    return { config: params.config, warnings: [], changed: false };
  }

  return {
    config: {
      ...params.config,
      plugins: {
        ...pluginsConfig,
        slots,
        entries,
      },
    },
    warnings,
    changed: true,
  };
}
