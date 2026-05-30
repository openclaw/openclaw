import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildProviderRegistry, runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";

const resolveApiKeyForProviderMock = vi.hoisted(() => vi.fn());
const requireApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: vi.fn(() => true),
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

function createBedrockCfg(): OpenClawConfig {
  return {
    models: {
      providers: {
        "amazon-bedrock": {
          authMode: "aws-sdk",
          models: [],
        },
      },
    },
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [
            {
              provider: "amazon-bedrock",
              model: "us.amazon.nova-pro-v1:0",
            },
          ],
        },
        video: {
          enabled: true,
          models: [
            {
              provider: "amazon-bedrock",
              model: "us.amazon.nova-pro-v1:0",
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("runCapability with amazon-bedrock auth-mode aws-sdk", () => {
  it("calls transcribeAudio with empty apiKey instead of throwing No API keys", async () => {
    resolveApiKeyForProviderMock.mockReset().mockResolvedValue({
      apiKey: "",
      source: "test",
      mode: "aws-sdk",
    });
    requireApiKeyMock.mockReset();

    let seenApiKey: string | undefined;
    const providerRegistry = buildProviderRegistry({
      "amazon-bedrock": {
        id: "amazon-bedrock",
        capabilities: ["audio"],
        transcribeAudio: async (req) => {
          seenApiKey = req.apiKey;
          return { text: "bedrock audio ok", model: req.model ?? "unknown" };
        },
      },
    });

    await withAudioFixture("openclaw-aws-sdk-audio", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "audio",
        cfg: createBedrockCfg(),
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.decision.outcome).toBe("success");
      expect(result.outputs[0]?.text).toBe("bedrock audio ok");
      expect(result.outputs[0]?.provider).toBe("amazon-bedrock");
    });

    expect(seenApiKey).toBe("");
    expect(requireApiKeyMock).not.toHaveBeenCalled();
  });

  it("calls describeVideo with empty apiKey instead of throwing No API keys", async () => {
    resolveApiKeyForProviderMock.mockReset().mockResolvedValue({
      apiKey: "",
      source: "test",
      mode: "aws-sdk",
    });
    requireApiKeyMock.mockReset();

    let seenApiKey: string | undefined;
    const providerRegistry = buildProviderRegistry({
      "amazon-bedrock": {
        id: "amazon-bedrock",
        capabilities: ["video"],
        describeVideo: async (req) => {
          seenApiKey = req.apiKey;
          return { text: "bedrock video ok", model: req.model ?? "unknown" };
        },
      },
    });

    await withVideoFixture("openclaw-aws-sdk-video", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "video",
        cfg: createBedrockCfg(),
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.decision.outcome).toBe("success");
      expect(result.outputs[0]?.text).toBe("bedrock video ok");
      expect(result.outputs[0]?.provider).toBe("amazon-bedrock");
    });

    expect(seenApiKey).toBe("");
    expect(requireApiKeyMock).not.toHaveBeenCalled();
  });

  it("still routes through requireApiKey when auth.mode is api-key", async () => {
    resolveApiKeyForProviderMock.mockReset().mockResolvedValue({
      apiKey: "real-key",
      source: "test",
      mode: "api-key",
    });
    requireApiKeyMock.mockReset().mockImplementation((auth: { apiKey?: string }) => {
      return auth.apiKey ?? "";
    });

    let seenApiKey: string | undefined;
    const providerRegistry = buildProviderRegistry({
      "amazon-bedrock": {
        id: "amazon-bedrock",
        capabilities: ["audio"],
        transcribeAudio: async (req) => {
          seenApiKey = req.apiKey;
          return { text: "ok", model: req.model ?? "unknown" };
        },
      },
    });

    await withAudioFixture("openclaw-api-key-audio", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "audio",
        cfg: createBedrockCfg(),
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expect(result.decision.outcome).toBe("success");
    });

    expect(seenApiKey).toBe("real-key");
    expect(requireApiKeyMock).toHaveBeenCalled();
  });
});
