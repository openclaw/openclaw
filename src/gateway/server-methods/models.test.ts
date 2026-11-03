import { describe, expect, it, vi } from "vitest";
import { materializePreparedModelCatalog } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  setupModelsListFixture,
  catalogLoader,
  requestModelsList,
} from "./models-list.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./models-list.test-support.js"));

describe("models.list", () => {
  setupModelsListFixture();

  it.each(["claude-fable-5-1", "Claude Gateway/claude-fable-5-1"])(
    "publishes the native Fable effort ladder for %s on a custom Messages provider",
    async (id) => {
      const { request, respond } = requestModelsList({
        view: "all",
        loadGatewayModelCatalog: vi.fn(async () => [
          {
            id,
            name: "Pooled Fable",
            provider: "proxy",
            api: "anthropic-messages",
            reasoning: true,
          },
        ]),
      });

      await request;

      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        models: [
          {
            id,
            provider: "proxy",
            thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((level) => ({
              id: level,
              label: level,
            })),
            thinkingDefault: "medium",
          },
        ],
      });
    },
  );

  it("loads the requested agent catalog", async () => {
    const loadGatewayModelCatalog = catalogLoader([
      { id: "writer-model", name: "Writer Model", provider: "test" },
    ]);
    const { request } = requestModelsList({
      view: "configured",
      agentId: "writer",
      runtimeConfig: {
        agents: {
          entries: {
            main: {},
            writer: { model: "test/writer-model" },
          },
        },
      },
      loadGatewayModelCatalog,
    });

    await request;

    expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "writer" }),
    );
  });

  it("returns typed selection-required until an explicit fleet selects an agent", async () => {
    const runtimeConfig = {
      agents: {
        ownership: "explicit" as const,
        entries: { ops: {}, research: {} },
      },
    };
    const missing = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader([]),
    });
    await missing.request;
    expect(missing.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );

    const selected = requestModelsList({
      view: "configured",
      includeDefaultModels: false,
      agentId: "research",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader([]),
    });
    await selected.request;
    expect(selected.respond).toHaveBeenCalledWith(true, { models: [] }, undefined);
  });

  it("reports API-key capability from provider auth contracts when requested", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      includeProviderCapabilities: true,
      loadGatewayModelCatalog: catalogLoader([
        { id: "claude-test", name: "Claude Test", provider: "anthropic" },
        { id: "copilot-test", name: "Copilot Test", provider: "github-copilot" },
        { id: "byteplus-test", name: "BytePlus Plan Test", provider: "byteplus-plan" },
        { id: "custom-test", name: "Custom Test", provider: "custom-cloud" },
      ]),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: expect.arrayContaining([
          expect.objectContaining({ provider: "anthropic", apiKeySupported: true }),
          expect.objectContaining({ provider: "github-copilot", apiKeySupported: false }),
          expect.objectContaining({ provider: "byteplus-plan", apiKeySupported: true }),
        ]),
      },
      undefined,
    );
    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<{ provider: string; apiKeySupported?: boolean }> }
      | undefined;
    const custom = payload?.models.find((model) => model.provider === "custom-cloud");
    expect(custom).toBeDefined();
    expect(custom).not.toHaveProperty("apiKeySupported");
  });

  it("projects exact CLI runtime thinking capabilities onto every configured Claude model", async () => {
    const modelIds = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ];
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" } },
            ]),
          ),
        },
      },
    };
    const loadGatewayModelCatalog = vi.fn(async () =>
      modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        provider: "anthropic",
        reasoning: true,
      })),
    );
    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "ultra", label: "ultra" },
        ],
      });
    }
  });

  it("preserves a configured reasoning opt-out on a Claude CLI route", async () => {
    const modelId = "claude-opus-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: modelId, name: modelId, reasoning: false }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = catalogLoader([
      { id: modelId, name: modelId, provider: "anthropic", reasoning: false },
      {
        id: modelId,
        name: `${modelId} (Claude CLI)`,
        provider: "claude-cli",
        reasoning: true,
      },
    ]);
    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "ultra", label: "ultra" },
      ],
    });
  });

  it("preserves mandatory Claude CLI thinking despite a configured reasoning opt-out", async () => {
    const modelId = "claude-fable-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: {
            models: [{ id: modelId, name: modelId, reasoning: false }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const materializedCatalog = materializePreparedModelCatalog(
      {
        entries: [{ id: modelId, name: modelId, provider: "anthropic", reasoning: false }],
        routeVariants: [],
      },
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: `${modelId} (Claude CLI)`,
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    ).entries;
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader(materializedCatalog),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [
        { id: "minimal", label: "minimal" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "adaptive", label: "adaptive" },
        { id: "high", label: "high" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
        { id: "ultra", label: "ultra" },
      ],
      thinkingDefault: "high",
    });
  });

  it("publishes a materialized Claude CLI logical row with its configured thinking default", async () => {
    const modelIds = ["claude-opus-5", "claude-sonnet-5"];
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelIds[0]}` },
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" }, params: { thinking: "medium" } },
            ]),
          ),
        },
      },
      models: {
        providers: {
          anthropic: { models: modelIds.map((id) => ({ id, name: id })) },
        },
      },
    } as unknown as OpenClawConfig;
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      // Prepared catalog shape: runtime-only rows are deliberately absent.
      loadGatewayModelCatalog: vi.fn(async () =>
        modelIds.map((id) => ({ id, name: id, provider: "anthropic", reasoning: true })),
      ),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingDefault: "medium",
        thinkingLevels: expect.arrayContaining([
          { id: "off", label: "off" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ]),
      });
    }
  });

  it("publishes the concrete Claude CLI thinking policy for a configured logical model", async () => {
    const modelId = "claude-mythos-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelId}` },
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: {
        providers: {
          anthropic: { models: [{ id: modelId, name: "Claude Mythos 5" }] },
        },
      },
    } as unknown as OpenClawConfig;
    const materializedCatalog = materializePreparedModelCatalog(
      {
        entries: [{ id: modelId, name: "Claude Mythos 5", provider: "anthropic" }],
        routeVariants: [],
      },
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: "Claude Mythos 5 (Claude CLI)",
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    ).entries;
    const { request, respond } = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader(materializedCatalog),
    });

    await request;

    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<Record<string, unknown>> }
      | undefined;
    const model = payload?.models.find(
      (entry) => entry.provider === "anthropic" && entry.id === modelId,
    );
    expect(model).toMatchObject({
      provider: "anthropic",
      reasoning: true,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "ultra", label: "ultra" },
      ],
      thinkingDefault: "off",
    });
    expect(model).not.toHaveProperty("thinkingPolicyProvider");
  });

  it("projects only public model fields", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: catalogLoader([
        {
          id: "demo-model",
          name: "Demo Model",
          provider: "demo-provider",
          contextWindow: 0,
          reasoning: "yes",
          api: "openai-responses",
          baseUrl: "https://private.example.test/v1",
          authRequirement: "api-key",
          agentRuntime: { id: "private-runtime" },
          params: { private: true },
        },
      ]),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "demo-model",
            name: "Demo Model",
            provider: "demo-provider",
            available: false,
            unavailableReason: "missing-auth",
          },
        ],
      },
      undefined,
    );
  });

  it("projects ordered thinking profiles without exposing raw compatibility metadata", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: catalogLoader([
        {
          id: "reasoning-model",
          name: "Reasoning Model",
          provider: "demo-provider",
          reasoning: true,
          compat: {
            supportedReasoningEfforts: ["max", "xhigh"],
            privateRouteHint: "do-not-publish",
          },
        },
      ]),
    });
    await request;

    const payload = respond.mock.calls[0]?.[1] as { models: Array<Record<string, unknown>> };
    expect(payload.models).toEqual([
      expect.objectContaining({
        id: "reasoning-model",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "minimal", label: "minimal" },
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
          { id: "xhigh", label: "xhigh" },
          { id: "max", label: "max" },
          { id: "ultra", label: "ultra" },
        ],
        thinkingDefault: "medium",
      }),
    ]);
    expect(payload.models[0]).not.toHaveProperty("compat");
  });

  it.each([
    { name: "model Fast", modelDefault: true, expected: true },
    { name: "model Standard", modelDefault: false, expected: false },
    { name: "model Auto", modelDefault: "auto", expected: "auto" },
    {
      name: "agent Fast over model Standard",
      agentDefault: true,
      modelDefault: false,
      expected: true,
    },
  ] as const)("projects the $name default", async ({ agentDefault, modelDefault, expected }) => {
    const { request, respond } = requestModelsList({
      view: "all",
      agentId: "main",
      runtimeConfig: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.6-luna": { params: { fastMode: modelDefault } } },
          },
          entries: {
            main: agentDefault === undefined ? {} : { fastModeDefault: agentDefault },
          },
        },
      },
      loadGatewayModelCatalog: catalogLoader([
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      ]),
    });
    await request;

    const payload = respond.mock.calls[0]?.[1] as { models: Array<Record<string, unknown>> };
    expect(payload.models[0]).toMatchObject({ effectiveFastMode: expected });
  });

  it("projects the effective context budget without exposing model input metadata", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: catalogLoader([
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "demo-provider",
          contextWindow: 128_000,
          contextTokens: 96_000,
          input: ["text", "image", "private-runtime-capability", "image"],
        },
      ]),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            available: false,
            unavailableReason: "missing-auth",
            contextWindow: 128_000,
            contextTokens: 96_000,
          },
        ],
      },
      undefined,
    );
  });

  it("propagates catalog load errors to the dispatch backstop", async () => {
    const { request, respond } = requestModelsList({
      view: "configured",
      loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
    });
    await expect(request).rejects.toThrow("catalog failed");
    expect(respond).not.toHaveBeenCalled();
  });
});
