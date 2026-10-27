import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createSpeechProviderRegistry } from "./provider-registry-core.js";
import { speechProvider as provider } from "./speech-provider.test-support.js";
import {
  resolveTtsProviderAsync,
  resolvePreparedTtsProvider,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
import { resolveTtsConfig } from "./tts-settings.js";

const mocks = vi.hoisted(() => ({
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    return normalized === "edge" ? "microsoft" : normalized || undefined;
  }),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(),
}));

vi.mock("./provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

describe("speech provider registry", () => {
  const select = (
    preference: Parameters<typeof resolvePreparedTtsProvider>[0]["preference"],
    providers: readonly SpeechProviderPlugin[],
    configuredByProvider = new Map<string, boolean>(),
  ) =>
    resolvePreparedTtsProvider({
      config: resolveTtsConfig({}),
      preference,
      providers,
      configuredByProvider,
    });
  it("resolves deterministic fallback order and aliases from a supplied provider inventory", () => {
    const inventory = [
      provider("openai", { aliases: ["oai"], autoSelectOrder: 5 }),
      provider("google", { autoSelectOrder: 1 }),
      provider("azure", { autoSelectOrder: 1 }),
      provider("elevenlabs", { autoSelectOrder: 3 }),
    ];

    const order = resolveTtsProviderOrder(" OAI ", undefined, inventory);
    expect(order).toEqual(["openai", "azure", "google", "elevenlabs"]);
  });

  it.each([
    [{ provider: "oai", source: "prefs" }, [provider("openai", { aliases: ["oai"] })], "openai"],
    [{ provider: "custom", source: "config" }, [], "custom"],
  ] as const)("preserves explicit selection: %j", (preference, inventory, expected) => {
    expect(select(preference, inventory)).toBe(expected);
  });

  it("keeps persona selection conditional on provider availability", () => {
    mocks.getSpeechProvider.mockReturnValueOnce(provider("persona-provider"));
    const preference = { provider: "persona-provider", source: "persona" } as const;

    expect(select(preference, [])).toBe("persona-provider");
    expect(select(preference, [provider("fallback")], new Map([["fallback", true]]))).toBe(
      "fallback",
    );
  });

  it("selects providers through async availability and observes subsequent changes", async () => {
    let configured = true;
    const isConfigured = vi.fn(() => {
      throw new Error("sync availability must not run");
    });
    const first = provider("first", {
      autoSelectOrder: 1,
      isConfigured,
      resolveConfig: () => ({ apiKey: "fixture-key" }),
      isConfiguredAsync: async ({ providerConfig }) =>
        configured && providerConfig.apiKey === "fixture-key",
    });
    const fallback = provider("fallback", { autoSelectOrder: 2 });
    const availableProviders = [first, fallback];
    const config = resolveTtsConfig({});
    const registry = createSpeechProviderRegistry({
      getProvider: (id) => availableProviders.find((entry) => entry.id === id),
      listProviders: () => availableProviders,
    });

    expect(await resolveTtsProviderAsync(config, "/unused", registry, {})).toBe("first");
    configured = false;
    expect(await resolveTtsProviderAsync(config, "/unused", registry, {})).toBe("fallback");
  });

  it("canonicalizes a voice-model alias omitted from the supplied inventory", () => {
    const inventory = [provider("openai")];
    const cfg = {
      agents: { defaults: { voiceModel: { primary: "edge/edge-tts" } } },
    } as OpenClawConfig;

    expect(resolveTtsProviderOrder("openai", cfg, inventory)).toEqual(["openai", "microsoft"]);
  });
});
