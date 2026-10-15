import { describe, expect, it, vi } from "vitest";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createGatewayLiveTestModel,
  isolateLiveGatewayConfig,
  resolveExplicitLiveModelCandidates,
} from "./gateway-models.profiles.live.test-helpers.js";

vi.mock("../agents/live-provider-owner.js", () => {
  const anthropicOwned = new Set(["anthropic", "claude-cli"]);
  return {
    liveProvidersShareOwningPlugin(left: string, right: string): boolean {
      return anthropicOwned.has(left) && anthropicOwned.has(right);
    },
  };
});

describe("isolateLiveGatewayConfig", () => {
  it("disables independent session-observer model traffic", () => {
    expect(
      isolateLiveGatewayConfig({
        gateway: { controlUi: { enabled: false, sessionObserver: true } },
      }).gateway?.controlUi,
    ).toMatchObject({ enabled: false, sessionObserver: false });
  });
});

describe("resolveExplicitLiveModelCandidates", () => {
  const pro = createGatewayLiveTestModel("deepseek", "deepseek-v4-pro");
  const anthropic = createGatewayLiveTestModel("anthropic", "claude-sonnet-4-6");
  const google = createGatewayLiveTestModel("google", "gemini-3.1-pro-preview");

  it.each(["deepseek/deepseek-v4-flash", "deepseek/"])(
    "rejects incomplete explicit selection %s even when another requested model exists",
    (missingRef) => {
      expect(() =>
        resolveExplicitLiveModelCandidates({
          modelRegistry: { find: (_provider, id) => (id === pro.id ? pro : undefined) },
          models: [pro],
          modelFilter: new Set([missingRef, "deepseek/deepseek-v4-pro"]),
          providerFilter: new Set(["deepseek"]),
          env: {},
        }),
      ).toThrow(`explicit model selection missed requested models: ${missingRef}.`);
    },
  );

  it("keeps canonical metadata from a targeted lookup outside the enumerated catalog", () => {
    const canonical = { ...pro, contextWindow: 234_567 };
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => canonical },
        models: [],
        modelFilter: new Set(["deepseek/deepseek-v4-pro"]),
        providerFilter: new Set(["deepseek"]),
        env: {},
      }),
    ).toEqual([canonical]);
  });

  it("rejects an explicit ref without canonical metadata", () => {
    expect(() =>
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [],
        modelFilter: new Set(["deepseek/missing-model"]),
        providerFilter: new Set(["deepseek"]),
        env: {},
      }),
    ).toThrow(/deepseek\/missing-model/);
  });

  it("normalizes retired Google refs before targeted lookup", () => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: {
          find: (provider, id) =>
            provider === google.provider && id === google.id ? google : undefined,
        },
        models: [],
        modelFilter: new Set(["google/gemini-3-pro-preview"]),
        providerFilter: new Set(["google"]),
        env: {},
      }),
    ).toEqual([google]);
  });

  it.each([
    {
      name: "case-insensitive references",
      refs: ["DEEPSEEK/DEEPSEEK-V4-PRO"],
      providers: ["deepseek"],
      models: [pro],
      expected: [pro],
    },
    {
      name: "provider ownership aliases",
      refs: ["claude-cli/claude-sonnet-4-6"],
      providers: ["claude-cli"],
      models: [anthropic],
      expected: [anthropic],
    },
    {
      name: "equivalent selectors",
      refs: ["claude-cli/claude-sonnet-4-6", "ANTHROPIC/CLAUDE-SONNET-4-6"],
      providers: ["anthropic"],
      models: [anthropic],
      expected: [anthropic],
    },
    {
      name: "provider allowlist intersection",
      refs: ["anthropic/claude-sonnet-4-6", "deepseek/deepseek-v4-pro"],
      providers: ["deepseek"],
      models: [anthropic, pro],
      expected: [pro],
    },
    {
      name: "ambiguous model-only selectors",
      refs: ["shared-model"],
      providers: null,
      models: [
        createGatewayLiveTestModel("provider-one", "shared-model"),
        createGatewayLiveTestModel("provider-two", "shared-model"),
      ],
      expected: [
        createGatewayLiveTestModel("provider-one", "shared-model"),
        createGatewayLiveTestModel("provider-two", "shared-model"),
      ],
    },
  ])("keeps matcher enumeration for $name", ({ refs, providers, models, expected }) => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models,
        modelFilter: new Set(refs),
        providerFilter: providers ? new Set(providers) : null,
        env: {},
      }),
    ).toEqual(expected);
  });

  it("keeps targeted Bedrock metadata when another selector requires enumeration", () => {
    const shared = createGatewayLiveTestModel("provider-one", "shared-model");
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [shared],
        modelFilter: new Set(["amazon-bedrock/global.anthropic.claude-sonnet-4-6", "shared-model"]),
        providerFilter: null,
        env: {},
      }),
    ).toMatchObject([
      {
        provider: "amazon-bedrock",
        id: "global.anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
      { provider: "provider-one", id: "shared-model" },
    ]);
  });

  it("preserves targeted metadata and scope while another selector enumerates", () => {
    const canonical = { ...anthropic, contextWindow: 234_567 };
    const shared = createGatewayLiveTestModel("provider-one", "shared-model");
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: {
          find: (provider, id) =>
            provider === canonical.provider && id === canonical.id ? canonical : undefined,
        },
        models: [anthropic, createGatewayLiveTestModel("claude-cli", anthropic.id), shared],
        modelFilter: new Set(["anthropic/claude-sonnet-4-6", "shared-model"]),
        providerFilter: null,
        env: {},
      }),
    ).toEqual([canonical, shared]);
  });

  it("applies the selected workspace's retirement policy to the model's actual route", () => {
    const workspaceDir = "/fixture/workspace";
    const empty = createPluginMetadataSnapshotFixture();
    const scoped = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "workspace-fixture",
          origin: "workspace",
          providers: ["workspace-fixture"],
          modelCatalog: {
            suppressions: [
              {
                provider: "workspace-fixture",
                model: "retired-model",
                retirement: { replacedBy: "current-model" },
                when: { baseUrlHosts: ["models.example.invalid"] },
              },
            ],
          },
        },
      ],
    });
    const metadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockImplementation((params) => (params.workspaceDir === workspaceDir ? scoped : empty));
    const retired = {
      ...createGatewayLiveTestModel("workspace-fixture", "retired-model"),
      baseUrl: "https://models.example.invalid/v1",
    };
    const config = { plugins: { entries: { "workspace-fixture": { enabled: true } } } };
    const select = (model: typeof retired) =>
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => model },
        models: [model],
        modelFilter: new Set(["workspace-fixture/retired-model"]),
        providerFilter: new Set(["workspace-fixture"]),
        config,
        workspaceDir,
        env: {},
      });
    try {
      expect(() => select(retired)).toThrow(/workspace-fixture\/retired-model/);
      const customRoute = { ...retired, baseUrl: "https://custom.example.invalid/v1" };
      expect(select(customRoute)).toEqual([customRoute]);
    } finally {
      metadata.mockRestore();
    }
  });

  it("preserves the existing Bedrock Converse fallback", () => {
    expect(
      resolveExplicitLiveModelCandidates({
        modelRegistry: { find: () => undefined },
        models: [],
        modelFilter: new Set(["amazon-bedrock/global.anthropic.claude-sonnet-4-6"]),
        providerFilter: new Set(["amazon-bedrock"]),
        env: {},
      }),
    ).toMatchObject([
      {
        provider: "amazon-bedrock",
        id: "global.anthropic.claude-sonnet-4-6",
        api: "bedrock-converse-stream",
      },
    ]);
  });
});
