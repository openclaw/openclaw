import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPairingAdapter, listPairingChannels } from "./pairing.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("channel pairing adapters", () => {
  it("skips plugins with unreadable pairing metadata", () => {
    const registry = createEmptyPluginRegistry();
    const brokenPlugin = Object.defineProperties(
      {
        id: "broken",
        meta: { label: "Broken" },
      },
      {
        pairing: {
          get() {
            throw new Error("channel pairing getter exploded");
          },
        },
      },
    );
    registry.channels = [
      {
        pluginId: "broken",
        plugin: brokenPlugin as never,
        source: "test",
      },
      {
        pluginId: "healthy",
        plugin: {
          id: "healthy",
          meta: { label: "Healthy" },
          pairing: { idLabel: "healthyUserId" },
        } as never,
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listPairingChannels()).toEqual(["healthy"]);
    expect(getPairingAdapter("broken")).toBeNull();
    expect(getPairingAdapter("healthy")?.idLabel).toBe("healthyUserId");
  });
});
