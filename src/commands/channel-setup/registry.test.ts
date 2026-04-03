import { describe, expect, it } from "vitest";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "./registry.js";

function createSetupPlugin(params: {
  setupWizard: ChannelSetupPlugin["setupWizard"];
}): ChannelSetupPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "demo",
      label: "Demo",
    }),
    setup: {
      applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
    },
    setupWizard: params.setupWizard,
  };
}

describe("resolveChannelSetupWizardAdapterForPlugin", () => {
  it("builds and caches adapters from the plugin setupWizard surface", () => {
    const setupWizard: ChannelSetupWizard = {
      channel: "demo",
      status: {
        configuredLabel: "Configured",
        unconfiguredLabel: "Not configured",
        resolveConfigured: () => false,
      },
      credentials: [],
    };
    const plugin = createSetupPlugin({ setupWizard });

    const adapter = resolveChannelSetupWizardAdapterForPlugin(plugin);

    expect(adapter?.channel).toBe("demo");
    expect(typeof adapter?.getStatus).toBe("function");
    expect(typeof adapter?.configure).toBe("function");
    expect(resolveChannelSetupWizardAdapterForPlugin(plugin)).toBe(adapter);
  });

  it("passes through adapter-shaped setupWizard surfaces", () => {
    const setupWizard = {
      channel: "demo",
      getStatus: async () => ({
        channel: "demo",
        configured: false,
        statusLines: [],
      }),
      configure: async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg }),
    };
    const plugin = createSetupPlugin({ setupWizard });

    expect(resolveChannelSetupWizardAdapterForPlugin(plugin)).toBe(setupWizard);
  });
});
