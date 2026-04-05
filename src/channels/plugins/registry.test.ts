import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { listChannelPlugins } from "./registry.js";

function withMalformedChannels(registry: PluginRegistry): PluginRegistry {
  const malformed = { ...registry } as PluginRegistry;
  (malformed as { channels?: unknown }).channels = undefined;
  return malformed;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("listChannelPlugins", () => {
  it("returns an empty list when runtime registry has no channels field", () => {
    const malformedRegistry = withMalformedChannels(createEmptyPluginRegistry());
    setActivePluginRegistry(malformedRegistry);

    expect(listChannelPlugins()).toEqual([]);
  });
});
