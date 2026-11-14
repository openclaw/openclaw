// Scoped registry handles must not share a cached target-normalization callback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginChannelRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

function scopedRegistry(channel: string, prefix: string) {
  return createTestRegistry([
    {
      pluginId: channel,
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: channel }),
        messaging: {
          normalizeTarget: (raw: string) => `${prefix}:${raw.trim()}`,
        },
      },
    },
  ]);
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("request-scoped target normalization", () => {
  it("does not let a process-root miss mask sequential scoped implementations", () => {
    const channel = "target-scope-sequential-fixture";
    const version = getActivePluginChannelRegistryVersion();
    const first = scopedRegistry(channel, "first");
    const second = scopedRegistry(channel, "second");
    expect(normalizeTargetForProvider(channel, " room ")).toBe("room");
    expect(
      withPluginRuntimeRegistryScope(first, () => normalizeTargetForProvider(channel, " room ")),
    ).toBe("first:room");
    expect(
      withPluginRuntimeRegistryScope(second, () => normalizeTargetForProvider(channel, " room ")),
    ).toBe("second:room");
    expect(
      withPluginRuntimeRegistryScope(first, () => normalizeTargetForProvider(channel, " room ")),
    ).toBe("first:room");
    expect(normalizeTargetForProvider(channel, " room ")).toBe("room");
    expect(getActivePluginChannelRegistryVersion()).toBe(version);
  });

  it("keeps both implementations when asynchronous request scopes interleave", async () => {
    const channel = "target-scope-interleaved-fixture";
    const version = getActivePluginChannelRegistryVersion();
    const first = scopedRegistry(channel, "first");
    const second = scopedRegistry(channel, "second");
    const resume = Promise.withResolvers<void>();
    const pending = withPluginRuntimeRegistryScope(first, async () => {
      const before = normalizeTargetForProvider(channel, " room ");
      await resume.promise;
      return [before, normalizeTargetForProvider(channel, " room ")];
    });
    const other = withPluginRuntimeRegistryScope(second, () =>
      normalizeTargetForProvider(channel, " room "),
    );
    resume.resolve();
    const firstResults = await pending;
    expect({ firstResults, other }).toEqual({
      firstResults: ["first:room", "first:room"],
      other: "second:room",
    });
    expect(getActivePluginChannelRegistryVersion()).toBe(version);
  });
});
