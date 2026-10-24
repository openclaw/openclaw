import { expect, it } from "vitest";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../../scripts/e2e/lib/fixtures/mock-openai-config.mjs";

const agentModel = (params: Record<string, unknown> = {}) => ({
  agentRuntime: { id: "openclaw" },
  params: { ...params, transport: "sse", openaiWsWarmup: false },
});

it("parses strict TCP port values", () => {
  expect(parseMockOpenAiPort("18080")).toBe(18080);
  expect(parseMockOpenAiPort(443)).toBe(443);

  for (const value of [undefined, "", "0", "65536", "1e3", "18080tcp"]) {
    expect(() => parseMockOpenAiPort(value, "test mock port")).toThrow(
      /test mock port must be a TCP port from 1 to 65535/u,
    );
  }
});

it.each([undefined, "openai/fixture-utility"])(
  "writes provider and agent defaults with utility model %s",
  (utilityModelRef) => {
    const cfg = {
      agents: {
        defaults: {
          mediaModels: { video: { primary: "example/video" } },
          models: { "openai/gpt-5.4": { params: { preserved: true } } },
        },
        entries: {
          main: {},
          second: { utilityModel: "old/model" },
          "release-agent": {
            model: { primary: "openai/gpt-5.4" },
            workspace: "/tmp/release-agent",
            models: { "openai/gpt-5.5": { params: { existing: true } } },
          },
        },
      },
      models: { providers: utilityModelRef ? {} : { openai: { request: { timeoutMs: 10_000 } } } },
    };

    applyMockOpenAiModelConfig(cfg, {
      includeImageDefaults: true,
      mockPort: "18181",
      modelRef: "openai/gpt-5.5",
      utilityModelRef,
    });

    expect(cfg.models.providers.openai).toMatchObject({
      api: "openai-responses",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      baseUrl: "http://127.0.0.1:18181/v1",
      request: { allowPrivateNetwork: true, ...(!utilityModelRef ? { timeoutMs: 10_000 } : {}) },
      models: ["gpt-5.5", ...(utilityModelRef ? ["fixture-utility"] : [])].map((id) =>
        expect.objectContaining({
          id,
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      ),
    });
    expect(cfg.agents.defaults).toMatchObject({
      imageModel: { primary: "openai/gpt-5.5", timeoutMs: 30_000 },
      mediaModels: {
        image: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
        video: { primary: "example/video" },
      },
      model: { primary: "openai/gpt-5.5" },
      models: {
        "openai/gpt-5.4": { params: { preserved: true } },
        "openai/gpt-5.5": agentModel(),
      },
    });
    expect(cfg.agents.defaults).not.toHaveProperty("imageGenerationModel");
    expect(cfg.agents.entries["release-agent"]).toMatchObject({
      model: { primary: "openai/gpt-5.5" },
      workspace: "/tmp/release-agent",
      models: { "openai/gpt-5.5": agentModel({ existing: true }) },
    });
    expect(cfg).toHaveProperty("plugins", { enabled: true });
    for (const agent of [cfg.agents.defaults, ...Object.values(cfg.agents.entries)]) {
      expect(agent).toMatchObject({
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": agentModel() },
      });
      if (utilityModelRef) {
        expect(agent).toMatchObject({
          utilityModel: utilityModelRef,
          models: { [utilityModelRef]: agentModel() },
        });
      }
    }
  },
);

it.each([
  ["string model", "openai/gpt-5.4"],
  ["missing model", undefined],
])("rewrites a canonical agent with a %s", (_label, model) => {
  const cfg = {
    agents: {
      defaults: { models: {} },
      entries: { main: model === undefined ? {} : { model } },
    },
    models: { providers: {} },
  };

  applyMockOpenAiModelConfig(cfg, { mockPort: 18181 });

  expect(cfg.agents.entries.main).toEqual({
    model: { primary: "openai/gpt-5.6-luna" },
    models: { "openai/gpt-5.6-luna": agentModel() },
  });
});
