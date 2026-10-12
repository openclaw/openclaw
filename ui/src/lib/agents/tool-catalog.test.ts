import { describe, expect, it } from "vitest";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import { resolveToolProfileOptions, resolveToolSections } from "./tool-catalog.ts";

const TOOLS_CATALOG_RESULT: ToolsCatalogResult = {
  agentId: "main",
  profiles: [
    { id: "minimal", label: "Minimal" },
    { id: "full", label: "Full" },
  ],
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: [
        {
          id: "read",
          label: "read",
          description: "Read file contents",
          source: "core",
          defaultProfiles: ["coding"],
        },
      ],
    },
    {
      id: "runtime",
      label: "Runtime",
      source: "core",
      tools: [
        {
          id: "exec",
          label: "exec",
          description: "Run shell commands",
          source: "core",
          defaultProfiles: ["coding"],
        },
      ],
    },
    {
      id: "plugin:my-plugin",
      label: "My Plugin",
      source: "plugin",
      pluginId: "my-plugin",
      tools: [
        {
          id: "my_tool",
          label: "my_tool",
          description: "Plugin tool",
          source: "plugin",
          pluginId: "my-plugin",
          defaultProfiles: [],
        },
      ],
    },
  ],
};

describe("resolveToolSections", () => {
  // Regression: gateway catalog labels are English-only, so localized UIs
  // rendered "Files"/"Runtime" section names even though translations exist.
  it("translates known core group labels in non-English locales", async () => {
    await i18n.setLocale("zh-CN");
    try {
      const sections = resolveToolSections(TOOLS_CATALOG_RESULT);
      expect(sections.map((section) => section.label)).toEqual([
        t("agents.toolCatalog.groups.files"),
        t("agents.toolCatalog.groups.runtime"),
        "My Plugin",
      ]);
      expect(sections[0]?.label).not.toBe("Files");
      expect(sections[1]?.label).not.toBe("Runtime");
      const fallbackTools = resolveToolSections(null).flatMap((section) => section.tools);
      expect(fallbackTools.find((tool) => tool.id === "read")?.description).toBe(
        t("agents.toolCatalog.descriptions.read"),
      );
      expect(fallbackTools.find((tool) => tool.id === "openclaw")?.description).toBe(
        "Delegate OpenClaw setup and repair",
      );
    } finally {
      await i18n.setLocale("en");
    }
  });
});

describe("resolveToolProfileOptions", () => {
  it("translates known profile labels in non-English locales", async () => {
    await i18n.setLocale("zh-CN");
    try {
      const profiles = resolveToolProfileOptions(TOOLS_CATALOG_RESULT);
      expect(profiles.map((profile) => profile.label)).toEqual([
        t("agents.toolCatalog.profiles.minimal"),
        t("agents.toolCatalog.profiles.full"),
      ]);
      expect(profiles[0]?.label).not.toBe("Minimal");
    } finally {
      await i18n.setLocale("en");
    }
  });
});
