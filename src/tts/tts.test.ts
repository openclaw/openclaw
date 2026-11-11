// TTS integration tests cover host runtime availability behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("tts runtime facade", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js");
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:MISSING_TTS_KEY"],
        reason: "secret reference was not found",
      },
    ]);
  });

  afterEach(async () => {
    const { setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js");
    setActiveDegradedSecretOwners([]);
    vi.doUnmock("../plugin-sdk/tts-runtime.js");
  });

  it("blocks explicit synthesis but preserves text delivery when TTS is cold", async () => {
    const { maybeApplyTtsToPayload, textToSpeech } = await import("../plugin-sdk/tts-runtime.js");
    const payload = { text: "Keep this text." };

    await expect(textToSpeech({ text: "Speak this.", cfg: {} })).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId: "tts",
    });
    await expect(maybeApplyTtsToPayload({ payload, cfg: {} })).resolves.toBe(payload);
  });

  it.each(["textToSpeech", "textToSpeechStream", "textToSpeechTelephony"] as const)(
    "blocks cold speech through the host's first %s call",
    async (method) => {
      // mock-isolation: the host must bootstrap TTS without evaluating the SDK facade.
      vi.doMock("../plugin-sdk/tts-runtime.js", () => {
        throw new Error("Host TTS must not load the SDK facade");
      });
      const { createPluginRuntime } = await import("../plugins/runtime/index.js");
      const runtime = createPluginRuntime();
      await expect(runtime.tts[method]({ text: "Speak this.", cfg: {} })).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "capability",
        ownerId: "tts",
      });
    },
  );
});
