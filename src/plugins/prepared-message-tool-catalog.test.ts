import { afterEach, expect, it } from "vitest";
import {
  listMessageActionDiscoveryChannels,
  resolveCurrentChannelMessageToolDiscoveryAdapter as discoveryAdapter,
} from "../channels/plugins/message-action-discovery.js";
import { listChannelPlugins } from "../channels/plugins/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  getPreparedMessageToolCatalog,
  getPreparedMessageToolCatalogForRegistry,
  settlePreparedMessageToolCatalog,
} from "./prepared-message-tool-catalog.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const registry = (...plugins: [string, ChannelPlugin][]) =>
  createTestRegistry(plugins.map(([pluginId, plugin]) => ({ pluginId, source: "test", plugin })));

function channel(id: string, reconcilesUnknownSend = false): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id: id as ChannelPlugin["id"] }),
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
    message: reconcilesUnknownSend
      ? {
          durableFinal: {
            capabilities: { reconcileUnknownSend: true },
            reconcileUnknownSend: async () => ({ status: "unresolved" }),
          },
        }
      : undefined,
  };
}

afterEach(() => resetPluginRuntimeStateForTest());

it("preserves canonical channel ordering and first-wins registration", () => {
  const first = channel("duplicate", true);
  first.meta.order = 5;
  const prioritized = channel("zeta");
  prioritized.meta.order = 1;
  setActivePluginRegistry(
    registry(
      ["alpha", channel("alpha")],
      ["first", first],
      ["duplicate", channel("duplicate")],
      ["zeta", prioritized],
    ),
  );

  const prepared = getPreparedMessageToolCatalog();

  expect(prepared?.channels.map((entry) => entry.id)).toEqual(["zeta", "duplicate", "alpha"]);
  expect(prepared?.channels.map((entry) => entry.id)).toEqual(
    listChannelPlugins().map((plugin) => plugin.id),
  );
  expect(prepared?.getChannel("duplicate")?.reconcilesUnknownSend).toBe(true);
});

it("settles versioned catalogs per registry and retains them across root swaps", () => {
  const first = registry(["alpha", channel("alpha", true)]);
  setActivePluginRegistry(first);

  const prepared = getPreparedMessageToolCatalog();
  expect(settlePreparedMessageToolCatalog()).toBe(prepared);
  expect(prepared?.channels.map((entry) => entry.id)).toEqual(["alpha"]);
  expect(prepared?.getChannel("alpha")?.reconcilesUnknownSend).toBe(true);

  const second = registry(["beta", channel("beta")]);
  setActivePluginRegistry(second);

  const replaced = getPreparedMessageToolCatalog();
  expect(replaced).not.toBe(prepared);
  expect(replaced?.version).not.toBe(prepared?.version);
  expect(replaced?.channels.map((entry) => entry.id)).toEqual(["beta"]);
  expect(discoveryAdapter("beta", prepared)).toBeNull();
  expect(discoveryAdapter("alpha", prepared)?.pluginId).toBe("alpha");
  expect(getPreparedMessageToolCatalogForRegistry(first)).toBe(prepared);
  expect(getPreparedMessageToolCatalogForRegistry(second)).toBe(replaced);
  expect(prepared?.channels.map((entry) => entry.id)).toEqual(["alpha"]);
  expect(listMessageActionDiscoveryChannels().map((entry) => entry.id)).toEqual(["beta"]);
  expect(listMessageActionDiscoveryChannels(replaced).map((entry) => entry.id)).toEqual(["beta"]);
  expect(discoveryAdapter("alpha")).toBeNull();
  expect(discoveryAdapter("beta")?.pluginId).toBe("beta");
  expect(discoveryAdapter("beta", replaced)?.pluginId).toBe("beta");
});
