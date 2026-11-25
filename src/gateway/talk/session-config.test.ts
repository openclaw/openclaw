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
