// Advanced renders without an include list: it shows every section that has no
// curated home (config-page computes its exclude list).
// Each curated page opens at its first section.
const CONFIG_SECTION_KEYS_BY_PAGE = {
  communications: ["messages", "tts", "transcripts"],
  appearance: ["__appearance__", "ui"],
  notifications: ["__notifications__"],
  security: ["security", "approvals"],
  automation: ["commands", "hooks", "bindings", "cron"],
  mcp: ["mcp"],
  memory: ["memory"],
  talk: ["talk"],
  infrastructure: ["gateway", "browser", "nodeHost", "discovery", "acp"],
  updates: ["update"],
  "ai-agents": ["agents", "skills", "tools", "session"],
  advanced: undefined,
} as const satisfies Record<string, readonly string[] | undefined>;

export type ConfigPageId = keyof typeof CONFIG_SECTION_KEYS_BY_PAGE;

// Search and page rendering must agree on section ownership, or a result can
// open a page whose editor rejects the section it promised to reveal.
const CONFIG_PAGE_BY_SECTION = new Map<string, ConfigPageId>(
  Object.entries(CONFIG_SECTION_KEYS_BY_PAGE).flatMap(([pageId, sectionKeys]) =>
    (sectionKeys ?? []).map((sectionKey) => [sectionKey, pageId as ConfigPageId] as const),
  ),
);

const EXTERNAL_SECTION_ROUTE_IDS = new Map<string, "plugin-settings">([
  ["plugins", "plugin-settings"],
]);

export const SCOPED_CONFIG_SECTION_KEYS = new Set([
  ...CONFIG_PAGE_BY_SECTION.keys(),
  ...EXTERNAL_SECTION_ROUTE_IDS.keys(),
]);

export function configSectionKeysForPage(pageId: ConfigPageId): readonly string[] | undefined {
  return CONFIG_SECTION_KEYS_BY_PAGE[pageId];
}

export function configPageForSection(sectionKey: string): ConfigPageId | "plugin-settings" {
  // Sections without a curated home render on the Advanced page.
  return (
    EXTERNAL_SECTION_ROUTE_IDS.get(sectionKey) ??
    CONFIG_PAGE_BY_SECTION.get(sectionKey) ??
    "advanced"
  );
}
