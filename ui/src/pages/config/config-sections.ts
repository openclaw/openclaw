// Advanced renders without an include list: it shows every section that has no
// curated home (config-page computes its exclude list).
// Each curated page opens at its first section.
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
