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

export const writeFixtureJson = (dir: string, name: string, value: unknown) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value));

export function channelFixtureSource(
  id: string,
  options: {
    label?: string;
    docsPath?: string;
    blurb?: string;
    configured?: boolean;
    resolveAccount?: false;
  } = {},
) {
  const label = options.label ?? "Fixture";
  const account = { accountId: "default", ...(options.configured ? { token: "configured" } : {}) };
  const resolveAccount =
    options.resolveAccount === false ? "undefined" : `(${JSON.stringify(account)})`;
  return `{
    id: ${JSON.stringify(id)},
    meta: { id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, selectionLabel: ${JSON.stringify(label)},
      docsPath: ${JSON.stringify(options.docsPath ?? "/channels/fixture")}, blurb: ${JSON.stringify(options.blurb ?? "fixture channel")} },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => ${options.configured ? '["default"]' : "[]"}, resolveAccount: () => ${resolveAccount} },
    outbound: { deliveryMode: "direct" },
  }`;
}

export function memoryCapabilityFixtureSource(prompt: string, label: string) {
  return `{
    promptBuilder: () => [${JSON.stringify(prompt)}],
    flushPlanResolver: () => ({
      softThresholdTokens: 10, forceFlushTranscriptBytes: 20, reserveTokensFloor: 30,
      prompt: ${JSON.stringify(label)}, systemPrompt: ${JSON.stringify(label)},
      relativePath: ${JSON.stringify(`memory/${label}.md`)},
    }),
    runtime: {
      async getMemorySearchManager() { return { manager: null, error: ${JSON.stringify(label)} }; },
      resolveMemoryBackendConfig() { return { backend: "builtin" }; },
    },
  }`;
}

export function memoryPublicArtifactsFixtureSource(workspaceDir: string, absolutePath: string) {
  return `{
    publicArtifacts: {
      async listArtifacts() {
        return [{ kind: "memory-root", workspaceDir: ${JSON.stringify(workspaceDir)},
          relativePath: "MEMORY.md", absolutePath: ${JSON.stringify(absolutePath)},
          agentIds: ["main"], contentType: "markdown" }];
      },
    },
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
