import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { createWebSearchTestProvider } from "../../test-utils/web-provider-runtime.test-helpers.js";
import { buildPluginShapeSummary } from "../inspect-shape.js";

describe("plugin shape compatibility matrix", () => {
  it("keeps hook-only, plain capability, and hybrid capability shapes explicit", () => {
    const { config, registry } = createPluginRegistryFixture({
      plugins: { entries: { "hook-only": { hooks: { allowConversationAccess: true } } } },
    });
    type Plugin = Parameters<typeof registerVirtualTestPlugin>[0];
    const register = (id: string, setup: Plugin["register"], contracts?: Plugin["contracts"]) =>
      registerVirtualTestPlugin({ registry, config, id, name: id, register: setup, contracts });

    register("hook-only", (api) => {
      api.on("before_prompt_build", () => ({ prependContext: "hook-only" }));
    });

    register("plain-provider", (api) => {
      api.registerProvider({ id: "plain-provider", label: "Plain Provider", auth: [] });
    });

    register("hybrid-company", (api) => {
      api.registerProvider({ id: "hybrid-company", label: "Hybrid Company", auth: [] });
      api.registerWebSearchProvider(
        createWebSearchTestProvider({
          pluginId: "hybrid-company",
          id: "hybrid-search",
          credentialPath: "tools.web.search.hybrid-search.apiKey",
        }),
      );
    });

    register("channel-demo", (api) => {
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({
            id: "channel-demo",
            label: "Channel Demo",
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
          }),
          outbound: { deliveryMode: "direct" },
        },
      });
    });

    register("session-catalog-demo", (api) => {
      api.registerSessionCatalog({
        id: "session-catalog-demo",
        label: "Session Catalog Demo",
        list: async () => [],
        read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
      });
    });

    register("document-extract-test", () => {}, { documentExtractors: ["pdf"] });

    const report = {
      workspaceDir: "/virtual-workspace",
      ...registry.registry,
    };
    expect(
      report.plugins.map((plugin) => {
        const { shape, capabilityMode, capabilities } = buildPluginShapeSummary({ plugin, report });
        return [plugin.id, shape, capabilityMode, capabilities.map(({ kind }) => kind)];
      }),
    ).toEqual([
      ["hook-only", "hook-only", "none", []],
      ["plain-provider", "plain-capability", "plain", ["text-inference"]],
      ["hybrid-company", "hybrid-capability", "hybrid", ["text-inference", "web-search"]],
      ["channel-demo", "plain-capability", "plain", ["channel"]],
      ["session-catalog-demo", "plain-capability", "plain", ["session-catalog"]],
      ["document-extract-test", "plain-capability", "plain", ["document-extractors"]],
    ]);
  });
});
