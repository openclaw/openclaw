// Verifies the generated Gateway startup projection stays compact, deterministic, and conflict-free.
import { describe, expect, it } from "vitest";
import { buildOfficialExternalPluginStartupMetadata } from "../../scripts/generate-official-external-plugin-startup-metadata.js";
import channelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import pluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import providerCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { GENERATED_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA } from "../../src/plugins/official-external-plugin-startup-metadata.generated.js";

function catalog(...entries: Record<string, unknown>[]) {
  return { entries };
}

function entry(params: {
  pluginId: string;
  packageName: string;
  source?: string;
  manifest?: Record<string, unknown>;
}) {
  return {
    name: params.packageName,
    source: params.source ?? "official",
    openclaw: {
      plugin: { id: params.pluginId },
      ...params.manifest,
    },
  };
}

describe("official external plugin startup metadata generator", () => {
  it("matches the checked-in compact projection", () => {
    const generated = buildOfficialExternalPluginStartupMetadata([
      channelCatalog,
      providerCatalog,
      pluginCatalog,
    ]);

    expect(generated).toEqual(GENERATED_OFFICIAL_EXTERNAL_PLUGIN_STARTUP_METADATA);
    expect(generated).toHaveLength(77);
    expect(generated.filter((record) => record.pluginId === "pixverse")).toHaveLength(1);
    const serialized = JSON.stringify(generated);
    expect(generated.find((record) => record.pluginId === "diffs")?.catalog).toEqual({
      featured: true,
      order: 40,
    });
    expect(
      generated.find((record) => record.pluginId === "wecom-openclaw-plugin")?.channelConfigs
        ?.wecom,
    ).toMatchObject({
      label: "WeCom",
      description: "Enterprise WeChat conversation channel.",
      schema: { type: "object", additionalProperties: true },
    });
    expect(
      generated.find((record) => record.pluginId === "wecom-openclaw-plugin")?.contracts?.tools,
    ).toEqual(["wecom_mcp"]);
    for (const excludedField of [
      '"authChoices"',
      '"expectedIntegrity"',
      '"selectionLabel"',
      '"signupUrl"',
    ]) {
      expect(serialized).not.toContain(excludedField);
    }
  });

  it("safely merges duplicate records owned by the same package", () => {
    const generated = buildOfficialExternalPluginStartupMetadata([
      catalog(
        entry({
          pluginId: "demo",
          packageName: "@openclaw/demo",
          manifest: {
            providers: [{ id: "demo", aliases: ["demo-ai"], envVars: ["DEMO_KEY"] }],
            contracts: { speechProviders: ["demo"] },
            channelConfigs: {
              demo: { label: "Demo", schema: { type: "object" } },
            },
          },
        }),
      ),
      catalog(
        entry({
          pluginId: "demo",
          packageName: "@openclaw/demo",
          manifest: {
            providers: [{ id: "demo", aliases: ["demo-cloud"], envVars: ["DEMO_TOKEN"] }],
            contracts: { speechProviders: ["demo-alt"] },
            channelConfigs: {
              demo: { schema: { type: "object" }, label: "Demo" },
            },
          },
        }),
      ),
    ]);

    expect(generated).toEqual([
      expect.objectContaining({
        pluginId: "demo",
        packageName: "@openclaw/demo",
        contracts: { speechProviders: ["demo", "demo-alt"] },
        channelConfigs: {
          demo: { label: "Demo", schema: { type: "object" } },
        },
        providers: [
          {
            id: "demo",
            aliases: ["demo-ai", "demo-cloud"],
            envVars: ["DEMO_KEY", "DEMO_TOKEN"],
          },
        ],
      }),
    ]);
  });

  it("projects every manifest-registry compatibility field", () => {
    const contracts = {
      embeddedExtensionFactories: ["embedded"],
      agentToolResultMiddleware: ["middleware"],
      trustedToolPolicies: ["policy"],
      externalAuthProviders: ["external-auth"],
      embeddingProviders: ["embedding"],
      memoryEmbeddingProviders: ["memory"],
      speechProviders: ["speech"],
      realtimeTranscriptionProviders: ["transcription"],
      realtimeVoiceProviders: ["voice"],
      mediaUnderstandingProviders: ["media"],
      transcriptSourceProviders: ["transcript"],
      documentExtractors: ["document"],
      imageGenerationProviders: ["image"],
      videoGenerationProviders: ["video"],
      musicGenerationProviders: ["music"],
      webContentExtractors: ["web-content"],
      webFetchProviders: ["web-fetch"],
      webSearchProviders: ["web-search"],
      workerProviders: ["worker"],
      usageProviders: ["usage"],
      migrationProviders: ["migration"],
      gatewayMethodDispatch: ["gateway"],
      tools: ["tool"],
    };
    const [generated] = buildOfficialExternalPluginStartupMetadata([
      catalog(
        entry({
          pluginId: "demo",
          packageName: "@openclaw/demo",
          manifest: {
            catalog: { featured: true, order: 7 },
            contracts,
            channelConfigs: {
              demo: {
                label: "Demo",
                description: "Demo channel",
                schema: { type: "object" },
                uiHints: { token: { sensitive: true } },
                preferOver: ["legacy-demo"],
                commands: { nativeCommandsAutoEnabled: false },
              },
            },
          },
        }),
      ),
    ]);

    expect(generated).toMatchObject({
      catalog: { featured: true, order: 7 },
      contracts,
      channelConfigs: {
        demo: {
          label: "Demo",
          description: "Demo channel",
          schema: { type: "object" },
          uiHints: { token: { sensitive: true } },
          preferOver: ["legacy-demo"],
          commands: { nativeCommandsAutoEnabled: false },
        },
      },
    });
  });

  it.each([
    {
      name: "plugin package ownership",
      catalogs: [
        catalog(entry({ pluginId: "demo", packageName: "@openclaw/demo" })),
        catalog(entry({ pluginId: "demo", packageName: "@openclaw/other" })),
      ],
      message: "packageName",
    },
    {
      name: "package plugin ownership",
      catalogs: [
        catalog(entry({ pluginId: "demo", packageName: "@openclaw/shared" })),
        catalog(entry({ pluginId: "other", packageName: "@openclaw/shared" })),
      ],
      message: "package",
    },
    {
      name: "lookup alias ownership",
      catalogs: [
        catalog(
          entry({
            pluginId: "demo",
            packageName: "@openclaw/demo",
            manifest: { providers: [{ id: "demo", aliases: ["shared-alias"] }] },
          }),
        ),
        catalog(
          entry({
            pluginId: "other",
            packageName: "@openclaw/other",
            manifest: { providers: [{ id: "other", aliases: ["shared-alias"] }] },
          }),
        ),
      ],
      message: "lookup id",
    },
    {
      name: "endpoint classification",
      catalogs: [
        catalog(
          entry({
            pluginId: "demo",
            packageName: "@openclaw/demo",
            manifest: {
              providerEndpoints: [{ endpointClass: "demo-native", hosts: ["api.example.test"] }],
            },
          }),
        ),
        catalog(
          entry({
            pluginId: "other",
            packageName: "@openclaw/other",
            manifest: {
              providerEndpoints: [{ endpointClass: "other-native", hosts: ["api.example.test"] }],
            },
          }),
        ),
      ],
      message: "endpoint",
    },
  ])("rejects conflicting $name", ({ catalogs, message }) => {
    expect(() => buildOfficialExternalPluginStartupMetadata(catalogs)).toThrow(message);
  });
});
