import { describe, expect, it } from "vitest";
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
import { buildInstalledPluginDetailTabs, installedPluginDetailTabFromHash } from "./detail-tabs.ts";

const emptyComponents: PluginsInspectResult["components"] = {
  mapped: [],
  skills: [],
  mcpServers: [],
  commands: [],
  hooks: [],
  lspServers: [],
  unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
};

describe("installed plugin detail tabs", () => {
  it("orders README then Configuration before supported component tabs", () => {
    expect(
      buildInstalledPluginDetailTabs({
        hasReadme: true,
        hasConfiguration: true,
        components: {
          ...emptyComponents,
          mapped: ["skills", "mcpServers", "commands", "hooks", "lspServers"],
          skills: ["triage"],
          mcpServers: ["notion"],
          commands: ["search"],
          hooks: ["SessionStart"],
          lspServers: ["typescript"],
        },
        hasCompatibility: true,
        hasVersions: true,
      }),
    ).toEqual([
      "readme",
      "configuration",
      "skills",
      "mcpServers",
      "commands",
      "hooks",
      "lspServers",
      "compatibility",
      "versions",
      "access",
      "lifecycle",
      "advanced",
    ]);
  });

  it("omits empty and detected-only component tabs", () => {
    expect(
      buildInstalledPluginDetailTabs({
        hasReadme: false,
        hasConfiguration: true,
        components: {
          ...emptyComponents,
          mapped: ["commands"],
          unavailable: {
            capabilities: ["agents", "hooks", "rules"],
            mcpServers: ["remote-only"],
            lspServers: [],
          },
        },
        hasCompatibility: false,
        hasVersions: false,
      }),
    ).toEqual(["configuration", "access", "lifecycle", "advanced"]);
  });

  it("restores supported deep links and rejects unknown fragments", () => {
    expect(installedPluginDetailTabFromHash("#configuration")).toBe("configuration");
    expect(installedPluginDetailTabFromHash("#not-a-plugin-tab")).toBe("readme");
  });
});
