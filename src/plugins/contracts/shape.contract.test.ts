import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginRegistry, type PluginRecord } from "../registry.js";
import type { PluginRuntime } from "../runtime/types.js";
import { buildAllPluginInspectReports } from "../status.js";
import type { OpenClawPluginApi } from "../types.js";

function createPluginRecord(id: string, name: string): PluginRecord {
  return {
    id,
    name,
    source: `/virtual/${id}/index.ts`,
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    speechProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    webSearchProviderIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

function registerTestPlugin(params: {
  registry: ReturnType<typeof createPluginRegistry>;
  config: OpenClawConfig;
  record: PluginRecord;
  register(api: OpenClawPluginApi): void;
}) {
  params.registry.registry.plugins.push(params.record);
  params.register(
    params.registry.createApi(params.record, {
      config: params.config,
    }),
  );
}

describe("plugin shape compatibility matrix", () => {
  it("keeps legacy hook-only, plain capability, and hybrid capability shapes explicit", () => {
    const config = {} as OpenClawConfig;
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord("lca-legacy", "LCA Legacy"),
      register(api) {
        api.on("before_agent_start", () => ({
          prependContext: "legacy",
        }));
      },
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord("plain-provider", "Plain Provider"),
      register(api) {
        api.registerProvider({
          id: "plain-provider",
          label: "Plain Provider",
          auth: [],
        });
      },
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord("hybrid-company", "Hybrid Company"),
      register(api) {
        api.registerProvider({
          id: "hybrid-company",
          label: "Hybrid Company",
          auth: [],
        });
        api.registerWebSearchProvider({
          id: "hybrid-search",
          label: "Hybrid Search",
          hint: "Search the web",
          envVars: ["HYBRID_SEARCH_KEY"],
          placeholder: "hsk_...",
          signupUrl: "https://example.com/signup",
          getCredentialValue: () => "hsk-test",
          setCredentialValue(searchConfigTarget, value) {
            searchConfigTarget.apiKey = value;
          },
          createTool: () => ({
            description: "Hybrid search",
            parameters: {},
            execute: async () => ({}),
          }),
        });
      },
    });

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord("channel-demo", "Channel Demo"),
      register(api) {
        api.registerChannel({
          plugin: {
            id: "channel-demo",
            meta: {
              id: "channel-demo",
              label: "Channel Demo",
              selectionLabel: "Channel Demo",
              docsPath: "/channels/channel-demo",
              blurb: "channel demo",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            outbound: { deliveryMode: "direct" },
          },
        });
      },
    });

    const inspect = buildAllPluginInspectReports({
      config,
      report: {
        workspaceDir: "/virtual-workspace",
        ...registry.registry,
      },
    });

    expect(
      inspect.map((entry) => ({
        id: entry.plugin.id,
        shape: entry.shape,
        capabilityMode: entry.capabilityMode,
      })),
    ).toEqual([
      {
        id: "lca-legacy",
        shape: "hook-only",
        capabilityMode: "none",
      },
      {
        id: "plain-provider",
        shape: "plain-capability",
        capabilityMode: "plain",
      },
      {
        id: "hybrid-company",
        shape: "hybrid-capability",
        capabilityMode: "hybrid",
      },
      {
        id: "channel-demo",
        shape: "plain-capability",
        capabilityMode: "plain",
      },
    ]);

    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect[1]?.capabilities.map((entry) => entry.kind)).toEqual(["text-inference"]);
    expect(inspect[2]?.capabilities.map((entry) => entry.kind)).toEqual([
      "text-inference",
      "web-search",
    ]);
    expect(inspect[3]?.capabilities.map((entry) => entry.kind)).toEqual(["channel"]);
  });
});
