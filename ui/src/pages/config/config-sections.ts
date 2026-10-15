// Advanced renders without an include list: it shows every section that has no
// curated home (config-page computes its exclude list).
// Each curated page opens at its first section.
import type { JsonSchema } from "../../lib/config-form-utils.ts";

const CONFIG_PAGES = [
  ["communications", ["messages", "tts", "transcripts"]],
  ["appearance", ["__appearance__", "ui"]],
  ["notifications", ["__notifications__"]],
  ["security", ["security", "approvals"]],
  ["automation", ["commands", "hooks", "bindings", "cron"]],
  ["mcp", ["mcp"]],
  ["memory", ["memory"]],
  ["talk", ["talk"]],
  ["infrastructure", ["gateway", "browser", "nodeHost", "discovery", "acp"]],
  ["updates", ["update"]],
  ["ai-agents", ["agents", "skills", "tools", "session"]],
  ["advanced", undefined],
] as const;

export type ConfigPageId = (typeof CONFIG_PAGES)[number][0];
export const CONFIG_PAGE_IDS = CONFIG_PAGES.map(([pageId]) => pageId);
const CONFIG_SECTION_KEYS_BY_PAGE = Object.fromEntries<readonly string[] | undefined>(CONFIG_PAGES);

// Search and page rendering must agree on section ownership, or a result can
// open a page whose editor rejects the section it promised to reveal.
const CONFIG_PAGE_BY_SECTION = new Map<string, ConfigPageId | "plugin-settings">([
  ...CONFIG_PAGES.flatMap(([pageId, sectionKeys]) =>
    (sectionKeys ?? []).map((sectionKey) => [sectionKey, pageId] as const),
  ),
  ["plugins", "plugin-settings"],
]);

export const SCOPED_CONFIG_SECTION_KEYS = new Set(CONFIG_PAGE_BY_SECTION.keys());

export function configSectionKeysForPage(pageId: ConfigPageId): readonly string[] | undefined {
  return CONFIG_SECTION_KEYS_BY_PAGE[pageId];
}

export function configPageForSection(sectionKey: string): ConfigPageId | "plugin-settings" {
  // Sections without a curated home render on the Advanced page.
  return CONFIG_PAGE_BY_SECTION.get(sectionKey) ?? "advanced";
}

export type ConfigSelection = { activeSection: string | null; activeSubsection: string | null };

export function defaultConfigSelection(pageId: ConfigPageId): ConfigSelection {
  const activeSection = configSectionKeysForPage(pageId)?.[0] ?? null;
  if (activeSection === null && pageId !== "advanced") {
    throw new Error("Unknown config page");
  }
  return { activeSection, activeSubsection: null };
}

export function normalizeConfigSelection(
  pageId: ConfigPageId,
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSelection {
  const sections = configSectionKeysForPage(pageId) ?? null;
  // Advanced renders without an include list; sections that have a curated
  // home elsewhere must not activate here.
  if (pageId === "advanced" && activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  if (sections && (!activeSection || !sections.includes(activeSection))) {
    return defaultConfigSelection(pageId);
  }
  return { activeSection, activeSubsection };
}

export function configSelectionFromSearch(pageId: ConfigPageId, search: string): ConfigSelection {
  const section = new URLSearchParams(search).get("section");
  if (!section) {
    return defaultConfigSelection(pageId);
  }
  return normalizeConfigSelection(pageId, section, null);
}

// Config leaf paths a curated settings control owns. The generic schema form and settings
// search must skip them, or the setting gets a second, unexplained home: Settings →
// Appearance → Language owns `ui.prefs.locale`, whose raw string schema would otherwise
// render as a bare empty "Locale" text box (and produce a dead-end search hit).
const CURATED_SETTINGS_OWNED_LEAF_PATHS: readonly string[] = ["ui.prefs.locale"];

function omitLeafPath(schema: JsonSchema, segments: readonly string[]): JsonSchema {
  const [segment, ...rest] = segments;
  const child = segment === undefined ? undefined : schema.properties?.[segment];
  if (segment === undefined || !schema.properties || !child) {
    return schema;
  }
  const nextProperties: Record<string, JsonSchema> = { ...schema.properties };
  if (rest.length === 0) {
    delete nextProperties[segment];
  } else {
    nextProperties[segment] = omitLeafPath(child, rest);
  }
  const required = schema.required?.filter((key) => Object.hasOwn(nextProperties, key));
  return { ...schema, properties: nextProperties, ...(required ? { required } : {}) };
}

/**
 * Removes curated-owner leaf paths from a schema. `prefix` is the config path of the schema
 * root: `""` for the whole config, or a section key such as `"ui"` for a section schema.
 */
export function omitCuratedOwnedConfigLeaves(schema: JsonSchema, prefix = ""): JsonSchema {
  let next = schema;
  for (const path of CURATED_SETTINGS_OWNED_LEAF_PATHS) {
    const relative = prefix
      ? path.startsWith(`${prefix}.`)
        ? path.slice(prefix.length + 1)
        : null
      : path;
    if (relative) {
      next = omitLeafPath(next, relative.split("."));
    }
  }
  return next;
}
