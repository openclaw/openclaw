import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { TempPlugin } from "./loader.test-fixtures.js";
import type { createPluginCache } from "./plugin-cache.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";

export function pluginFixtureConfig(
  plugin: Pick<TempPlugin, "id" | "file">,
  entry?: PluginEntryConfig,
  allow = true,
) {
  return {
    plugins: {
      ...(allow ? { allow: [plugin.id] } : {}),
      load: { paths: [plugin.file] },
      slots: { memory: "none" },
      ...(entry ? { entries: { [plugin.id]: entry } } : {}),
    },
  };
}

export function writeFixtureJson(dir: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
}

/** A valid channel registration; these loader tests do not exercise channel I/O. */
export function channelFixtureSource(id: string) {
  return `{
    id: ${JSON.stringify(id)},
    meta: { id: ${JSON.stringify(id)}, label: "Fixture", selectionLabel: "Fixture",
      docsPath: "/channels/fixture", blurb: "fixture channel" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => [], resolveAccount: () => ({ accountId: "default" }) },
    outbound: { deliveryMode: "direct" },
  }`;
}

export async function callFixtureGatewayMethod(handler: GatewayRequestHandler, method: string) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "fixture", method },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as Parameters<GatewayRequestHandler>[0]["context"],
  });
  return respond;
}

export async function disposeLoaderFixtures(
  registries: PluginRegistry[],
  caches: ReturnType<typeof createPluginCache>[] = [],
) {
  for (const registry of registries.splice(0).toReversed()) {
    await disposePluginRegistryInstances(registry);
  }
  for (const cache of caches.splice(0).toReversed()) {
    await cache[Symbol.asyncDispose]();
  }
}
