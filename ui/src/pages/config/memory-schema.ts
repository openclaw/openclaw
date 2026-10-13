// Config facts about the `memory` section, with no rendering imports.
//
// The Memory page is behind the lazy `import("./config-page.tsx")` route, but
// settings search runs from app-host at startup. Both need the same answers
// about which `memory.*` children are reachable and where a match lives, so
// those answers live here rather than in the view module — importing the view
// from search would pull lit, hub-tabs, and settings-ui into the startup chunk.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { defaultSlotIdForKey, resolveSlotSelection } from "../../../../src/plugins/slots.ts";
import { memoryTabFromPath, pathForMemoryTab, type MemoryRouteTab } from "../../app-route-paths.ts";

export type MemoryTab = MemoryRouteTab;

export type MemoryEngineSelection = ReturnType<typeof resolveSlotSelection>;

export const DEFAULT_MEMORY_ENGINE_ID = defaultSlotIdForKey("memory");

const MEMORY_TABS: readonly MemoryTab[] = ["overview", "memories", "dreams", "settings"];

/** Reads a `?tab=` value from a settings-search destination or a shared link. */
function normalizeMemoryTab(value: string | null | undefined): MemoryTab | null {
  if (value === "search") {
    return "settings";
  }
  if (value === "dreaming") {
    return "dreams";
  }
  return MEMORY_TABS.find((tab) => tab === value) ?? null;
}

/** Old settings-search URLs had a memory section/hash but no tab. */
export function memoryTabForRoute(
  route: {
    pathname?: string;
    tab?: string | null;
    section?: string | null;
    targetBlockId?: string | null;
  },
  basePath = "",
): MemoryTab | null {
  const pathTab = route.pathname ? memoryTabFromPath(route.pathname, basePath) : null;
  if (pathTab && pathTab !== "overview") {
    return pathTab;
  }
  const tab = normalizeMemoryTab(route.tab);
  if (tab) {
    return tab;
  }
  const target = route.targetBlockId ?? "";
  if (route.section === "memory" || target.startsWith("config-section-memory")) {
    return "settings";
  }
  return pathTab;
}

export function canonicalMemoryRouteLocation(
  route: {
    pathname: string;
    search: string;
    hash: string;
    tab?: string | null;
    section?: string | null;
    targetBlockId?: string | null;
    advanced?: boolean;
  },
  basePath = "",
): RouteLocation | null {
  const params = new URLSearchParams(route.search);
  const hadLegacyTab = params.has("tab");
  const hadLegacySection = route.section === "memory" && params.has("section");
  params.delete("tab");
  if (hadLegacySection) {
    params.delete("section");
  }
  const search = params.toString();
  const canonical: RouteLocation = {
    pathname: pathForMemoryTab(memoryTabForRoute(route, basePath) ?? "overview", basePath),
    search: search ? `?${search}` : "",
    hash: route.hash,
  };
  return hadLegacyTab || hadLegacySection || canonical.pathname !== route.pathname
    ? canonical
    : null;
}

/** The plugin that currently owns the slot, or null when nothing does. */
export function selectedEngineId(selection: MemoryEngineSelection): string | null {
  return selection.kind === "off" ? null : selection.pluginId;
}

export function resolveMemoryEngineSelection(
  configObject: Record<string, unknown>,
): MemoryEngineSelection {
  const slots = asConfigRecord(asConfigRecord(configObject.plugins)?.slots);
  return resolveSlotSelection("memory", slots?.memory);
}

export const MEMORY_SETTINGS_KEYS = ["citations", "search"] as const;

// Stable schema identity keeps the config view's analysis cached across renders.
const memorySettingsSchemas = new WeakMap<Record<string, unknown>, unknown>();

export function memorySettingsSchema(schema: unknown): unknown {
  const root = asConfigRecord(schema);
  const memorySchema = asConfigRecord(asConfigRecord(root?.properties)?.memory);
  const memoryProperties = asConfigRecord(memorySchema?.properties);
  if (!root || !memorySchema || !memoryProperties) {
    return schema;
  }
  const hit = memorySettingsSchemas.get(root);
  if (hit !== undefined) {
    return hit;
  }
  const retained = Object.fromEntries(
    MEMORY_SETTINGS_KEYS.filter((key) => key in memoryProperties).map((key) => [
      key,
      memoryProperties[key],
    ]),
  );
  const narrowed = {
    ...root,
    properties: { memory: { ...memorySchema, properties: retained } },
  };
  memorySettingsSchemas.set(root, narrowed);
  return narrowed;
}
