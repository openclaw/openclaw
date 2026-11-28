// TTS capability tests cover channel plugin text-to-speech capability detection.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveChannelTtsVoiceDelivery } from "./tts-capabilities.js";

describe("resolveChannelTtsVoiceDelivery", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("resolves bundled channel voice delivery before the channel registry loads", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(resolveChannelTtsVoiceDelivery("Telegram")).toMatchObject({
      synthesisTarget: "voice-note",
    });
  });
});
