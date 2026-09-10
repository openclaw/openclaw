import { describe, expect, it } from "vitest";
import type { PluginCatalogItem, PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import {
  buildPluginConfigurationSet,
  createPluginConfigurationDraft,
  hasPluginConfigurationChanges,
  installedPluginForWizard,
  installRequestForDiscoveryDetail,
  installedPluginWizardStage,
  patchPluginConfigurationDraft,
  removePluginConfigurationDraftValue,
} from "./install-wizard-model.ts";

function detail(overrides: Partial<PluginDiscoveryDetailResult> = {}): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: "ch_bWF0cml4",
      catalog: {
        name: "Matrix",
        family: "code-plugin",
        official: true,
        categories: ["channels"],
      },
      local: {
        present: false,
        installed: false,
        enabled: false,
        state: "not-installed",
        action: "install",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: "matrix",
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
    ...overrides,
  };
}

describe("plugin install wizard model", () => {
  it("uses the ClawHub package identity for remote details", () => {
    expect(installRequestForDiscoveryDetail(detail())).toEqual({
      source: "clawhub",
      packageName: "matrix",
    });
  });

  it("uses the Gateway-projected install action for a local-only plugin", () => {
    const result = detail();
    result.detail.origin = "local";
    result.plugin.local.install = { source: "official", pluginId: "matrix" };
    expect(installRequestForDiscoveryDetail(result)).toEqual({
      source: "official",
      pluginId: "matrix",
    });
  });

  it("refuses installed, unavailable, and identity-less entries", () => {
    const installed = detail();
    installed.plugin.local.installed = true;
    expect(installRequestForDiscoveryDetail(installed)).toBeNull();

    const unavailable = detail();
    unavailable.plugin.local.action = "unavailable";
    expect(installRequestForDiscoveryDetail(unavailable)).toBeNull();

    const identityLess = detail();
    delete identityLess.detail.packageName;
    expect(installRequestForDiscoveryDetail(identityLess)).toBeNull();
  });

  it("uses authoritative post-restart state to choose configuration or enablement", () => {
    const plugin = {
      id: "matrix",
      name: "Matrix",
      installed: true,
      enabled: false,
      state: "disabled",
      removable: true,
    } satisfies PluginCatalogItem;
    expect(installedPluginWizardStage(plugin)).toBe("enabling");
    expect(installedPluginWizardStage({ ...plugin, state: "needs-setup" })).toBe("configuring");
    expect(installedPluginWizardStage({ ...plugin, enabled: true, state: "enabled" })).toBe(
      "success",
    );
  });

  it("resolves the installed plugin from the wizard's package identity", () => {
    const plugin = {
      id: "matrix-runtime",
      packageName: "matrix",
      name: "Matrix",
      installed: true,
      enabled: false,
      state: "needs-setup",
      removable: true,
    } satisfies PluginCatalogItem;
    expect(
      installedPluginForWizard(
        { plugins: [plugin], diagnostics: [], mutationAllowed: true },
        {
          catalogId: "ch_bWF0cml4",
          detail: detail(),
          request: { source: "clawhub", packageName: "matrix" },
          stage: "reconnecting",
        },
      ),
    ).toBe(plugin);
  });

  it("removes an unset value without mutating the loaded config", () => {
    const config = {
      plugins: {
        entries: {
          matrix: {
            config: { homeserver: "https://matrix.example", accessToken: "secret" },
          },
        },
      },
    };
    const draft = removePluginConfigurationDraftValue(
      createPluginConfigurationDraft(config, "matrix"),
      ["plugins", "entries", "matrix", "config", "accessToken"],
    );

    expect(hasPluginConfigurationChanges(createPluginConfigurationDraft(config, "matrix"))).toBe(
      false,
    );
    expect(hasPluginConfigurationChanges(draft)).toBe(true);
    expect(buildPluginConfigurationSet(config, draft)).toEqual({
      plugins: {
        entries: {
          matrix: { config: { homeserver: "https://matrix.example" } },
        },
      },
    });
    expect(config.plugins.entries.matrix.config.accessToken).toBe("secret");
  });

  it("replaces changed plugin config arrays without changing siblings", () => {
    const config = {
      plugins: {
        entries: {
          matrix: { config: { rooms: ["engineering", "support"], untouched: ["alerts"] } },
        },
      },
    };
    const draft = patchPluginConfigurationDraft(
      createPluginConfigurationDraft(config, "matrix"),
      ["plugins", "entries", "matrix", "config", "rooms"],
      ["engineering"],
    );

    const current = structuredClone(config);
    current.plugins.entries.matrix.config.untouched.push("concurrent");
    expect(buildPluginConfigurationSet(current, draft)).toEqual({
      plugins: {
        entries: {
          matrix: { config: { rooms: ["engineering"], untouched: ["alerts", "concurrent"] } },
        },
      },
    });
  });

  it("preserves an explicit nullable plugin configuration value", () => {
    const config = {
      plugins: {
        entries: {
          matrix: { config: { mode: "auto", untouched: true } },
        },
      },
    };
    const draft = patchPluginConfigurationDraft(
      createPluginConfigurationDraft(config, "matrix"),
      ["plugins", "entries", "matrix", "config", "mode"],
      null,
    );
    expect(buildPluginConfigurationSet(config, draft)).toMatchObject({
      plugins: {
        entries: {
          matrix: { config: { mode: null, untouched: true } },
        },
      },
    });
  });
});
