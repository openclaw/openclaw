import { afterEach, describe, expect, it } from "vitest";
import {
  pinActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { loadChannelOutboundAdapter } from "./load.js";

describe("loadChannelOutboundAdapter", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("uses pinned channel registry while active registry swaps", async () => {
    const startupAdapter = { deliveryMode: "gateway" };
    const startup = createEmptyPluginRegistry();
    startup.channels = [
      {
        plugin: {
          id: "slack",
          outbound: startupAdapter,
        } as never,
      } as never,
    ];

    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    expect(await loadChannelOutboundAdapter("slack")).toBe(startupAdapter);

    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    expect(await loadChannelOutboundAdapter("slack")).toBe(startupAdapter);
  });
});
