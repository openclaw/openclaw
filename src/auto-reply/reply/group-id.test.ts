// Tests group id derivation for channel sessions and persisted routes.
import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { extractExplicitGroupId } from "./group-id.js";

const { telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});

describe("extractExplicitGroupId simple targets", () => {
  it("asks the channel for the base group of a topic", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    expect(extractExplicitGroupId("telegram:group:-1003776849159:topic:999")).toBe(
      "-1003776849159",
    );
  });
});
