import { expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import {
  buildTalkTranscriptionConfig,
  resolveConfiguredRealtimeTranscriptionProvider,
} from "./session-config.js";

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
  return { providers: [provider("saved-only", 35, false), provider("keyed", 40, true)] };
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

const voiceCall = {
  plugins: { entries: { "voice-call": { config: { streaming: { provider: "keyed" } } } } },
};

it("keeps the Talk media path selected even when no media model is available", async () => {
  const config = { ...voiceCall, talk: { transcription: { provider: "media-understanding" } } };
  await expect(
    buildTalkTranscriptionConfig(config, undefined, undefined, undefined, Promise.resolve(undefined)),
  ).resolves.toMatchObject({ source: "media-understanding", file: undefined });
  await expect(buildTalkTranscriptionConfig(config, "saved-only")).resolves.toMatchObject({
    source: "streaming",
    provider: "saved-only",
  });
});

it("uses the Talk streaming provider before the Voice Call provider", async () => {
  const config = { ...voiceCall, talk: { transcription: { provider: "saved-only" } } };
  await expect(buildTalkTranscriptionConfig(config)).resolves.toMatchObject({
    source: "streaming",
    provider: "saved-only",
  });
  await expect(buildTalkTranscriptionConfig(voiceCall)).resolves.toMatchObject({
    source: "streaming",
    provider: "keyed",
  });
});
