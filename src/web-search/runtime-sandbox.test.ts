import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationRegistryScope } from "../plugins/runtime/generation-state.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "./runtime.js";

// mock-isolation: Machine discovery policy is unrelated to provider trust; avoid state DB I/O.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));

describe.each([true, false])(
  "web_search trust with runtime preference %s",
  (preferRuntimeProviders) => {
    it.each<{
      origin: PluginManifestRecord["origin"];
      trustedOfficialInstall?: boolean;
      sandboxed?: boolean;
      allowed: boolean;
    }>([
      { origin: "workspace", sandboxed: true, allowed: false },
      { origin: "global", sandboxed: true, allowed: false },
      { origin: "bundled", sandboxed: true, allowed: true },
      { origin: "global", trustedOfficialInstall: true, sandboxed: true, allowed: true },
      { origin: "workspace", sandboxed: false, allowed: true },
      { origin: "workspace", allowed: true },
    ])("$origin / trusted $trustedOfficialInstall / sandboxed $sandboxed", async (scenario) => {
      const config: OpenClawConfig = {
        tools: { web: { search: { provider: "fixture-search" } } },
        plugins: { allow: ["fixture-search"], entries: { "fixture-search": { enabled: true } } },
      };
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-search",
            contracts: { webSearchProviders: ["fixture-search"] },
            origin: scenario.origin,
            trustedOfficialInstall: scenario.trustedOfficialInstall,
          },
        ],
      });
      const execute = vi.fn(async () => ({ results: ["fixture answer"] }));
      const createTool = vi.fn(() => ({ description: "search", parameters: {}, execute }));
      const registry = createEmptyPluginRegistry();
      registry.webSearchProviders.push({
        pluginId: "fixture-search",
        provider: createWebSearchTestProvider({
          pluginId: "fixture-search",
          id: "fixture-search",
          credentialPath: "",
          requiresCredential: false,
          createTool,
        }),
      });
      const result = withPluginMetadataSnapshotScope(
        snapshot,
        () =>
          withPluginRuntimeGenerationRegistryScope(registry, () =>
            runWebSearch({
              config,
              preferInputConfig: true,
              preferRuntimeProviders,
              sandboxed: scenario.sandboxed,
              authStore: { version: 1, profiles: {} },
              args: { query: "sandbox trust proof" },
            }),
          ),
        { config, trustConfigIdentity: true },
      );
      if (scenario.allowed) {
        await expect(result).resolves.toEqual({
          provider: "fixture-search",
          result: { results: ["fixture answer"] },
        });
        expect(execute).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow("web_search is disabled or no provider is available.");
        expect(createTool).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      }
    });
  },
);
