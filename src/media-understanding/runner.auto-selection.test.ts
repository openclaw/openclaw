import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { mediaModels } from "./media-config.test-support.js";
import { buildMediaUnderstandingRegistry } from "./provider-registry.js";
import { runMediaFixture } from "./runner-case.test-support.js";
import { resolveAutoImageModel } from "./runner.js";
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

describe("automatic media selection", () => {
  it("resolves explicit image defaults when fallback discovery is unavailable", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { imageModel: { primary: "openrouter/google/gemini-2.5-flash" } } },
    };
    selection.discover.mockImplementation(() => {
      throw new Error("fallback provider discovery unavailable");
    });
    await expect(
      resolveAutoImageModel({ cfg, activeModel: { provider: "openai", model: "gpt-4.1" } }),
    ).resolves.toEqual({ provider: "openrouter", model: "google/gemini-2.5-flash" });
  });

  it.each(["manifest", "config"] as const)(
    "auto-selects hookless image providers from %s",
    async (source) => {
      const provider = "selection-image";
      const cfg: OpenClawConfig = {};
      if (source === "config") {
        cfg.models = mediaModels(provider, "vision", ["text", "image"]);
      } else {
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
    "normalizes the active %s provider alias",
    async (capability) => {
      selection.providers.push({
        id: "google",
        capabilities: ["image", "video"],
        describeImage: async ({ model }) => ({ text: "image", model }),
        describeVideo: async ({ model }) => ({ text: "video", model }),
      });
      const activeModel = { provider: " GEMINI ", model: "selected-model" };
      const cfg: OpenClawConfig = {};
      let outcome: { provider?: string; model?: string } | null;
      if (capability === "image") {
        outcome = await resolveAutoImageModel({ cfg, activeModel });
      } else {
        const result = await runMediaFixture("video", "media-selection-alias", {
          cfg,
          activeModel,
          providerRegistry: buildMediaUnderstandingRegistry(),
        });
        expect(result.decision.outcome).toBe("success");
        expect(result.outputs).toHaveLength(1);
        outcome = result.outputs[0] ?? null;
      }
      expect(outcome).toMatchObject({ model: "selected-model", provider: "google" });
      expect(selection.auth).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "google" }),
      );
    },
  );

  it("checks audio providers once in priority order until auth is available", async () => {
    selection.auth.mockImplementation(async ({ provider }) => provider === "second");
    const providers = ["first", "second"].map((id, priority): MediaUnderstandingProvider => ({
      id,
      capabilities: ["audio"],
      autoPriority: { audio: priority },
      defaultModels: { audio: `${id}-transcription` },
      transcribeAudio: async ({ model }) => ({ text: id, model }),
    }));
    const result = await runMediaFixture("audio", "media-selection-provider-order", {
      cfg: {},
      providerRegistry: new Map(providers.map((provider) => [provider.id, provider])),
    });
    const checkedProviders = selection.auth.mock.calls.map(([{ provider }]) => provider);
    expect(checkedProviders).toEqual(["first", "second"]);
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
