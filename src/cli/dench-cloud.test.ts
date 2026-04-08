import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDenchCloudConfigPatch,
  fetchDenchCloudCatalog,
  normalizeDenchCloudCatalogResponse,
  readConfiguredDenchCloudSettings,
  validateDenchCloudApiKey,
} from "./dench-cloud.js";
import { buildDenchCloudConfigPatch as buildRuntimePluginConfigPatch } from "../../extensions/dench-ai-gateway/index.js";

function createJsonResponse(params?: {
  status?: number;
  payload?: unknown;
}): Response {
  const status = params?.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => params?.payload ?? {},
  } as unknown as Response;
}

describe("dench-cloud helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes the public gateway catalog into stable model records", () => {
    const models = normalizeDenchCloudCatalogResponse({
      object: "list",
      data: [
        {
          id: "gpt-5.4",
          stableId: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai",
          transportProvider: "openai",
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 128000,
          supportsStreaming: true,
          supportsImages: true,
          supportsResponses: true,
          supportsReasoning: false,
          cost: {
            input: 3.375,
            output: 20.25,
            cacheRead: 0,
            cacheWrite: 0,
            marginPercent: 0.35,
          },
        },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.4",
        stableId: "gpt-5.4",
        displayName: "GPT-5.4",
        contextWindow: 128000,
        maxTokens: 128000,
        cost: expect.objectContaining({
          input: 3.375,
          output: 20.25,
          marginPercent: 0.35,
        }),
      }),
    ]);
  });

  it("falls back to the bundled model list when the public catalog is unavailable", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ status: 503, payload: {} }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await fetchDenchCloudCatalog("https://gateway.merseoriginals.com");
    expect(fetchMock).toHaveBeenCalledWith("https://gateway.merseoriginals.com/v1/public/models");
    expect(result.source).toBe("fallback");
    expect(result.models.map((model) => model.stableId)).toEqual([
      "anthropic.claude-opus-4-6-v1",
      "gpt-5.4",
      "anthropic.claude-sonnet-4-6-v1",
    ]);
  });

  it("rejects invalid Dench Cloud API keys with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createJsonResponse({ status: 401, payload: {} })) as unknown as typeof fetch,
    );

    await expect(
      validateDenchCloudApiKey("https://gateway.merseoriginals.com", "bad-key"),
    ).rejects.toThrow("Check your key at dench.com/settings");
  });

  it("builds the Dench Cloud config patch with provider models and agent aliases", () => {
    const patch = buildDenchCloudConfigPatch({
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench_live_key",
      models: [
        {
          id: "claude-opus-4.6",
          stableId: "anthropic.claude-opus-4-6-v1",
          displayName: "Claude Opus 4.6",
          provider: "anthropic",
          transportProvider: "bedrock",
          api: "openai-responses",
          input: ["text", "image"],
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 64000,
          supportsStreaming: true,
          supportsImages: true,
          supportsResponses: true,
          supportsReasoning: false,
          cost: {
            input: 6.75,
            output: 33.75,
            cacheRead: 0,
            cacheWrite: 0,
            marginPercent: 0.35,
          },
        },
      ],
    });

    expect(patch.models.providers["dench-cloud"]).toEqual(
      expect.objectContaining({
        baseUrl: "https://gateway.merseoriginals.com/v1",
        apiKey: "dench_live_key",
        api: "openai-responses",
        models: [
          expect.objectContaining({
            id: "anthropic.claude-opus-4-6-v1",
            name: "Claude Opus 4.6 (Dench Cloud)",
          }),
        ],
      }),
    );
    expect(patch.agents.defaults.models["dench-cloud/anthropic.claude-opus-4-6-v1"]).toEqual(
      expect.objectContaining({
        alias: "Claude Opus 4.6 (Dench Cloud)",
      }),
    );
    expect(patch.messages.tts.provider).toBe("elevenlabs");
    expect(patch.messages.tts.providers.elevenlabs).toEqual({
      baseUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench_live_key",
    });
    expect((patch.messages.tts as Record<string, unknown>).elevenlabs).toBeUndefined();
    expect(patch.mcp.servers.composio).toEqual({
      url: "https://gateway.merseoriginals.com/v1/composio/mcp",
      transport: "streamable-http",
      headers: {
        Authorization: "Bearer dench_live_key",
      },
    });
    expect(patch.tools.alsoAllow).toEqual([
      "composio_search_tools",
      "composio_resolve_tool",
      "composio_call_tool",
    ]);
  });

  it("keeps the runtime plugin patch in parity with the CLI/web helper", () => {
    const params = {
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench_live_key",
      models: [
        {
          id: "claude-opus-4.6",
          stableId: "anthropic.claude-opus-4-6-v1",
          displayName: "Claude Opus 4.6",
          provider: "anthropic",
          transportProvider: "bedrock",
          api: "openai-responses" as const,
          input: ["text" as const, "image" as const],
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 64000,
          supportsStreaming: true,
          supportsImages: true,
          supportsResponses: true,
          supportsReasoning: false,
          cost: {
            input: 6.75,
            output: 33.75,
            cacheRead: 0,
            cacheWrite: 0,
            marginPercent: 0.35,
          },
        },
      ],
    };

    expect(buildRuntimePluginConfigPatch(params)).toEqual(buildDenchCloudConfigPatch(params));
  });

  it("reads existing Dench Cloud gateway config from openclaw.json", () => {
    const result = readConfiguredDenchCloudSettings({
      models: {
        providers: {
          "dench-cloud": {
            baseUrl: "https://gateway.merseoriginals.com/v1",
            apiKey: "dench_cfg_key",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/anthropic.claude-opus-4-6-v1",
          },
        },
      },
    });

    expect(result).toEqual({
      gatewayUrl: "https://gateway.merseoriginals.com",
      apiKey: "dench_cfg_key",
      selectedModel: "anthropic.claude-opus-4-6-v1",
      ttsElevenLabsBaseUrl: undefined,
    });
  });

  it("reads existing TTS ElevenLabs baseUrl from openclaw.json", () => {
    const result = readConfiguredDenchCloudSettings({
      models: {
        providers: {
          "dench-cloud": {
            baseUrl: "https://gateway.merseoriginals.com/v1",
            apiKey: "dench_cfg_key",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/gpt-5.4",
          },
        },
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          providers: {
            elevenlabs: {
              baseUrl: "https://gateway.merseoriginals.com",
              apiKey: "dench_cfg_key",
            },
          },
        },
      },
    });

    expect(result.ttsElevenLabsBaseUrl).toBe("https://gateway.merseoriginals.com");
  });

  it("reads legacy flat TTS ElevenLabs config from openclaw.json", () => {
    const result = readConfiguredDenchCloudSettings({
      models: {
        providers: {
          "dench-cloud": {
            baseUrl: "https://gateway.merseoriginals.com/v1",
            apiKey: "dench_cfg_key",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "dench-cloud/gpt-5.4",
          },
        },
      },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: {
            baseUrl: "https://gateway.merseoriginals.com",
            apiKey: "dench_cfg_key",
          },
        },
      },
    });

    expect(result.ttsElevenLabsBaseUrl).toBe("https://gateway.merseoriginals.com");
  });
});
