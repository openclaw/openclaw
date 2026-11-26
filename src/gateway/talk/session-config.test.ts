import { expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import { resolveConfiguredRealtimeTranscriptionProvider } from "./session-config.js";

const mocks = vi.hoisted(() => {
  // "saved-only" is ready only once named, like a provider whose one key is a saved key.
  const provider = (
    id: string,
    autoSelectOrder: number,
    keyed: boolean,
  ): RealtimeTranscriptionProviderPlugin => ({
    id,
    label: id,
    autoSelectOrder,
    isConfigured: () => keyed,
    isConfiguredAsync: async (ctx) => keyed || ctx.selectedExplicitly === true,
    createSession: () => {
      throw new Error("not used");
    },
  });
  return { provider, providers: [provider("saved-only", 35, false), provider("keyed", 40, true)] };
});
// mock-isolation: Two fixture providers stand in for the plugin registry.
vi.mock("../../realtime-transcription/provider-registry.js", () => ({
  listRealtimeTranscriptionProviders: () => [...mocks.providers],
  getRealtimeTranscriptionProvider: (id?: string) =>
    mocks.providers.find((provider) => provider.id === id),
}));

it("tells a transcription provider it is named, and not during automatic selection", async () => {
  const select = async (configuredProviderId?: string) =>
    (
      await resolveConfiguredRealtimeTranscriptionProvider({
        config: {},
        configuredProviderId,
        providerConfigs: {},
      })
    ).provider.id;
  expect(await select()).toBe("keyed");
  expect(await select("saved-only")).toBe("saved-only");
});

it("says a provider is unconfigured when registered providers have no credentials", async () => {
  const previous = mocks.providers.splice(
    0,
    mocks.providers.length,
    mocks.provider("deepgram", 10, false),
    mocks.provider("elevenlabs", 20, false),
  );
  try {
    await expect(
      resolveConfiguredRealtimeTranscriptionProvider({
        config: {},
        providerConfigs: {},
      }),
    ).rejects.toThrow(
      "No realtime transcription provider is configured; check Voice Call streaming credentials",
    );
  } finally {
    mocks.providers.splice(0, mocks.providers.length, ...previous);
  }
});

it("says no provider is registered only when the transcription registry is empty", async () => {
  const previous = mocks.providers.splice(0, mocks.providers.length);
  try {
    await expect(
      resolveConfiguredRealtimeTranscriptionProvider({
        config: {},
        providerConfigs: {},
      }),
    ).rejects.toThrow("No realtime transcription provider registered");
  } finally {
    mocks.providers.splice(0, mocks.providers.length, ...previous);
  }
});
