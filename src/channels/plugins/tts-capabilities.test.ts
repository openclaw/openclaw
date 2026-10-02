// TTS capability tests cover channel plugin text-to-speech capability detection.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveChannelTtsVoiceDelivery } from "./tts-capabilities.js";
import type { ChannelPlugin } from "./types.js";

function createChannelPlugin(
  id: string,
  capabilities: ChannelPlugin["capabilities"],
): ChannelPlugin {
  return createChannelTestPluginBase({
    id,
    label: id,
    capabilities,
    config: {
      listAccountIds: () => ["default"],
    },
  });
}

describe("resolveChannelTtsVoiceDelivery", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("reads voice delivery behavior from channel plugin capabilities", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          plugin: createChannelPlugin("imessage", {
            chatTypes: ["direct"],
            tts: {
              voice: {
                synthesisTarget: "audio-file",
                audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
                preferAudioFileFormat: "caf",
              },
            },
          }),
          source: "test",
        },
      ]),
    );
    expect(resolveChannelTtsVoiceDelivery("imessage")).toEqual({
      synthesisTarget: "audio-file",
      audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
      preferAudioFileFormat: "caf",
    });
    expect(resolveChannelTtsVoiceDelivery("slack")).toBeUndefined();
  });
});
