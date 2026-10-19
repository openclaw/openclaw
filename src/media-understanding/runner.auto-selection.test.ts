import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { buildMediaUnderstandingRegistry } from "./provider-registry.js";
import { resolveAutoImageModel, runCapability } from "./runner.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

const selection = vi.hoisted(() => {
  const providers: MediaUnderstandingProvider[] = [];
  return {
    providers,
    discover: vi.fn<() => MediaUnderstandingProvider[]>(),
    auth: vi.fn<(params: { provider: string }) => Promise<boolean>>(),
  };
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return {
    ...createAvailableModelAuthMockModule(),
    hasAvailableAuthForProvider: selection.auth,
  };
});

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: selection.discover,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: async () => [],
  readPreparedModelCatalog: async () => [],
}));

beforeEach(() => {
  selection.providers.length = 0;
  selection.discover.mockReset().mockImplementation(() => selection.providers);
  selection.auth.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  selection.providers.length = 0;
  selection.discover.mockReset();
  selection.auth.mockReset();
});

describe("automatic media selection", () => {
  it("resolves explicit image defaults when fallback discovery is unavailable", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { imageModel: { primary: "openrouter/google/gemini-2.5-flash" } } },
    };
    await selection.discover.withImplementation(
      () => {
        throw new Error("fallback provider discovery unavailable");
      },
      async () => {
        await expect(
          resolveAutoImageModel({ cfg, activeModel: { provider: "openai", model: "gpt-4.1" } }),
        ).resolves.toEqual({ provider: "openrouter", model: "google/gemini-2.5-flash" });
      },
    );
  });

  it.each(["manifest", "config"] as const)(
    "auto-selects hookless image providers from %s",
    async (source) => {
      const provider = "selection-image";
      const cfg: OpenClawConfig =
        source === "config"
          ? {
              models: {
                providers: {
                  [provider]: {
                    baseUrl: "https://image.example/v1",
                    models: [
                      {
                        id: "vision",
                        name: "Vision",
                        reasoning: false,
                        input: ["text", "image"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 8192,
                        maxTokens: 128,
                      },
                    ],
                  },
                },
              },
            }
          : {};
      if (source === "manifest") {
        selection.providers.push({
          id: provider,
          capabilities: ["image"],
          defaultModels: { image: "vision" },
          autoPriority: { image: 1 },
        });
      }

      expect(await resolveAutoImageModel({ cfg })).toEqual({ provider, model: "vision" });
      expect(selection.auth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider }));
    },
  );

  it.each(["image", "video"] as const)(
    "selects the active %s model through its normalized provider alias",
    async (capability) => {
      selection.providers.push({
        id: "google",
        capabilities: ["image", "video"],
        describeImage: async ({ model }) => ({ text: "image", model }),
        describeVideo: async ({ model }) => ({ text: "video", model }),
      });
      const activeModel = { provider: " GEMINI ", model: "selected-model" };
      const cfg: OpenClawConfig = {};
      let outcome: { provider?: string; model?: string } | null = null;
      if (capability === "image") {
        outcome = await resolveAutoImageModel({ cfg, activeModel });
      } else {
        await withVideoFixture("media-selection-alias", async ({ ctx, media, cache }) => {
          const result = await runCapability({
            capability: "video",
            cfg,
            ctx,
            media,
            attachments: cache,
            activeModel,
            providerRegistry: buildMediaUnderstandingRegistry(),
          });
          expect(result.decision.outcome).toBe("success");
          expect(result.outputs).toHaveLength(1);
          outcome = result.outputs[0] ?? null;
        });
      }
      expect(outcome).toMatchObject({ model: "selected-model", provider: "google" });
      expect(selection.auth).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "google" }),
      );
    },
  );

  it("checks audio providers once in priority order until auth is available", async () => {
    const calls: string[] = [];
    selection.auth.mockImplementation(async ({ provider }) => {
      calls.push(provider);
      return provider === "second";
    });
    const providers = ["first", "second"].map((id, priority): MediaUnderstandingProvider => ({
      id,
      capabilities: ["audio"],
      autoPriority: { audio: priority },
      defaultModels: { audio: `${id}-transcription` },
      transcribeAudio: async ({ model }) => ({ text: id, model }),
    }));
    await withAudioFixture("media-selection-provider-order", async ({ ctx, media, cache }) => {
      const result = await runCapability({
        capability: "audio",
        cfg: {},
        ctx,
        media,
        attachments: cache,
        providerRegistry: new Map(providers.map((provider) => [provider.id, provider])),
      });
      expect(calls).toEqual(["first", "second"]);
      expect(result.outputs).toEqual([
        {
          kind: "audio.transcription",
          attachmentIndex: 0,
          provider: "second",
          model: "second-transcription",
          text: "second",
        },
      ]);
      expect(result.decision.outcome).toBe("success");
    });
  });
});
