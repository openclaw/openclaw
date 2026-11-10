import { expect, it } from "vitest";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../../scripts/e2e/lib/fixtures/mock-openai-config.mjs";

const ref = "openai/gpt-5.5";
const utility = "openai/fixture-utility";
const agentModel = (params: Record<string, unknown> = {}) => ({
  agentRuntime: { id: "openclaw" },
  params: { ...params, transport: "sse", openaiWsWarmup: false },
});

it("parses strict TCP ports and rejects missing, malformed, and out-of-range values", () => {
  expect(parseMockOpenAiPort("18080")).toBe(18080);
  expect(parseMockOpenAiPort(443)).toBe(443);
  for (const value of [undefined, "1e3", "65536"]) {
    expect(() => parseMockOpenAiPort(value, "test mock port")).toThrow(
      /test mock port must be a TCP port from 1 to 65535/u,
    );
  }
});

it("merges provider, media, utility and per-agent settings", () => {
  const cfg = {
    agents: {
      defaults: {
        mediaModels: { video: { primary: "example/video" } },
        models: { "openai/gpt-5.4": { params: { preserved: true } } },
      },
      entries: {
        second: { utilityModel: "old/model" },
        release: {
          model: { primary: "old/model" },
          workspace: "/tmp/release-agent",
          models: { [ref]: { params: { existing: true } } },
        },
      },
    },
    models: { providers: { openai: { request: { timeoutMs: 10_000 } } } },
  };
  applyMockOpenAiModelConfig(cfg, {
    includeImageDefaults: true,
    mockPort: "18181",
    modelRef: ref,
    utilityModelRef: utility,
  });
  expect(cfg.models.providers.openai).toMatchObject({
    api: "openai-responses",
    request: { allowPrivateNetwork: true, timeoutMs: 10_000 },
    models: ["gpt-5.5", "fixture-utility"].map((id) => expect.objectContaining({ id })),
  });
  expect(cfg.agents.defaults).toMatchObject({
    imageModel: { primary: ref, timeoutMs: 30_000 },
    mediaModels: {
      image: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
      video: { primary: "example/video" },
    },
    models: { "openai/gpt-5.4": { params: { preserved: true } } },
  });
  expect(cfg.agents.defaults).not.toHaveProperty("imageGenerationModel");
  expect(cfg.agents.entries.release).toMatchObject({
    workspace: "/tmp/release-agent",
    models: { [ref]: agentModel({ existing: true }) },
  });
  expect(cfg).toHaveProperty("plugins", { enabled: true });
  for (const agent of [cfg.agents.defaults, ...Object.values(cfg.agents.entries)]) {
    expect(agent).toMatchObject({
      model: { primary: ref },
      utilityModel: utility,
      models: { [ref]: agentModel(), [utility]: agentModel() },
    });
  }
});
