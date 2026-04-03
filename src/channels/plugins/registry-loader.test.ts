import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelRegistration, PluginRegistry } from "../../plugins/registry.js";

const getActivePluginChannelRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryVersionMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistry: (...args: unknown[]) =>
    getActivePluginChannelRegistryMock(...args),
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  getActivePluginRegistryVersion: (...args: unknown[]) =>
    getActivePluginRegistryVersionMock(...args),
}));

import { createChannelRegistryLoader } from "./registry-loader.js";

function createChannelRegistration(params: {
  id: string;
  source: string;
}): PluginChannelRegistration {
  return {
    pluginId: params.id,
    plugin: { id: params.id } as PluginChannelRegistration["plugin"],
    source: params.source,
  };
}

function createRegistry(channels: PluginChannelRegistration[]): PluginRegistry {
  return {
    channels,
  } as PluginRegistry;
}

describe("createChannelRegistryLoader", () => {
  beforeEach(() => {
    getActivePluginChannelRegistryMock.mockReset().mockReturnValue(createRegistry([]));
    getActivePluginChannelRegistryVersionMock.mockReset().mockReturnValue(1);
    getActivePluginRegistryMock.mockReset().mockReturnValue(createRegistry([]));
    getActivePluginRegistryVersionMock.mockReset().mockReturnValue(1);
  });

  it("prefers the pinned channel registry before falling back to the active registry", async () => {
    getActivePluginChannelRegistryMock.mockReturnValue(
      createRegistry([createChannelRegistration({ id: "signal", source: "pinned" })]),
    );
    getActivePluginRegistryMock.mockReturnValue(
      createRegistry([createChannelRegistration({ id: "signal", source: "active" })]),
    );

    const loader = createChannelRegistryLoader((entry) => entry.source);

    await expect(loader("signal")).resolves.toBe("pinned");
  });

  it("clears cached fallback results when the active registry version changes", async () => {
    const resolveValue = vi.fn((entry: PluginChannelRegistration) => entry.source);
    const loader = createChannelRegistryLoader(resolveValue);

    getActivePluginChannelRegistryMock.mockReturnValue(createRegistry([]));
    getActivePluginChannelRegistryVersionMock.mockReturnValue(10);
    getActivePluginRegistryMock.mockReturnValue(
      createRegistry([createChannelRegistration({ id: "late", source: "active-v1" })]),
    );
    getActivePluginRegistryVersionMock.mockReturnValue(20);

    await expect(loader("late")).resolves.toBe("active-v1");
    expect(resolveValue).toHaveBeenCalledTimes(1);

    getActivePluginRegistryMock.mockReturnValue(
      createRegistry([createChannelRegistration({ id: "late", source: "active-v2" })]),
    );
    getActivePluginRegistryVersionMock.mockReturnValue(21);

    await expect(loader("late")).resolves.toBe("active-v2");
    expect(resolveValue).toHaveBeenCalledTimes(2);
  });
});
