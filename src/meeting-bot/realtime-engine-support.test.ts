import { expect, it } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import { resolveMeetingRealtimeTranscriptionProvider } from "./realtime-engine-support.js";

it("tells a transcription provider it is named, and not when it is the default pick", async () => {
  // Ready only once named, like a provider whose one key is a saved key.
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "saved-only",
    label: "saved-only",
    isConfigured: () => false,
    isConfiguredAsync: async (ctx) => ctx.selectedExplicitly === true,
    createSession: () => {
      throw new Error("not used");
    },
  };
  const resolve = (transcriptionProvider?: string) =>
    resolveMeetingRealtimeTranscriptionProvider({
      config: { realtime: { transcriptionProvider, providers: {} } },
      fullConfig: {},
      providers: [provider],
    });
  await expect(resolve()).rejects.toThrow('"saved-only" is not configured');
  expect((await resolve("saved-only")).provider).toBe(provider);
});
