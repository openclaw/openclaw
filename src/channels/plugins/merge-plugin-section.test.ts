import { expect, it } from "vitest";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { mergeChannelPlugins } from "./merge-plugin-section.js";
import type { ChannelPlugin } from "./types.plugin.js";

it.each(["merge", "override"] as const)(
  "merges channel sections while preserving %s setup semantics",
  (mode) => {
    const defaultAccountId = () => "runtime";
    const validateInput = () => null;
    const runtime: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "example", label: "Runtime" }),
      setup: { applyAccountConfig: ({ cfg }) => cfg, validateInput },
      gatewayMethods: ["runtime.only"],
    };
    runtime.config.defaultAccountId = defaultAccountId;
    const setup: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "example", label: "Setup" }),
      setup: { applyAccountConfig: ({ cfg }) => cfg },
      gatewayMethods: undefined,
    };
    setup.config.defaultAccountId = undefined;

    const merged = mergeChannelPlugins(runtime, setup, mode);

    expect(merged.meta.label).toBe("Setup");
    expect(merged.config.defaultAccountId).toBe(defaultAccountId);
    expect(merged.config.resolveAccount).toBe(setup.config.resolveAccount);
    expect(merged).toHaveProperty("gatewayMethods", undefined);
    expect(merged.setup?.applyAccountConfig).toBe(setup.setup?.applyAccountConfig);
    if (mode === "merge") {
      expect(merged.setup?.validateInput).toBe(validateInput);
    } else {
      expect(merged.setup).toBe(setup.setup);
      expect(merged.setup?.validateInput).toBeUndefined();
    }
    expect(runtime.config.defaultAccountId).toBe(defaultAccountId);
    expect(setup.config.defaultAccountId).toBeUndefined();
  },
);
