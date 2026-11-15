// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadControlUiSourceCatalog } from "../../../../scripts/lib/control-ui-i18n-catalog.ts";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  ADVANCED_EXCLUDED_SECTIONS,
  configPageForSection,
  configSectionKeysForPage,
  type ConfigPageId,
} from "./config-sections.ts";
import { SETTINGS_SEARCH_TARGETS, type SettingsSearchTarget } from "./settings-targets.ts";

describe("settings search target manifest", () => {
  const targets: readonly SettingsSearchTarget[] = Object.values(SETTINGS_SEARCH_TARGETS);

  it("indexes only translation keys present in the English source catalog", () => {
    const source = flattenTranslations(loadControlUiSourceCatalog());
    for (const target of targets) {
      for (const key of [
        target.labelKey,
        ...target.searchKeys,
        ...Object.keys(target.nativeSearchKeys ?? {}),
      ]) {
        expect(source.has(key), `Missing settings search translation: ${key}`).toBe(true);
      }
    }
  });
});

describe("settings config section ownership", () => {
  const pages: readonly ConfigPageId[] = [
    "communications",
    "appearance",
    "notifications",
    "security",
    "automation",
    "mcp",
    "memory",
    "talk",
    "infrastructure",
    "updates",
    "ai-agents",
  ];

  it("assigns each curated section to exactly one page", () => {
    const sections = pages.flatMap((page) => configSectionKeysForPage(page) ?? []);

    expect(new Set(sections).size).toBe(sections.length);
    expect(new Set(ADVANCED_EXCLUDED_SECTIONS)).toEqual(new Set([...sections, "plugins"]));
  });

  it("keeps uncurated sections on Advanced", () => {
    expect(configPageForSection("wizard")).toBe("advanced");
    expect(configPageForSection("secrets")).toBe("advanced");
    expect(configPageForSection("broadcast")).toBe("advanced");
    expect(configPageForSection("models")).toBe("advanced");
  });
});
