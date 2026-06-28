// Control UI registry tests cover compatibility for plugin-declared descriptors.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./status.test-helpers.js";

describe("plugin registry Control UI descriptors", () => {
  it("keeps legacy flat descriptors loadable for shipped JavaScript plugins", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "legacy-descriptor-fixture",
        name: "Legacy Descriptor Fixture",
      }),
      register(api) {
        api.registerControlUiDescriptor({
          id: "legacy-card",
          name: "Legacy Card",
          description: "Legacy descriptor from a JavaScript plugin",
        } as never);
      },
    });

    expect(registry.registry.controlUiDescriptors).toEqual([
      expect.objectContaining({
        pluginId: "legacy-descriptor-fixture",
        descriptor: expect.objectContaining({
          id: "legacy-card",
          surface: "session",
          label: "Legacy Card",
        }),
      }),
    ]);
  });
});
