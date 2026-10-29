/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";

describe("incoming voice-note presentation", () => {
  it.each([true, false])("keeps incoming audio inline only for voice notes (%s)", (isVoiceNote) => {
    const container = document.createElement("div");
    const view = mountSolid(
      () =>
        createComponent(AssistantAttachments, {
          attachments: [
            {
              type: "attachment",
              attachment: {
                kind: "audio",
                label: "voice.wav",
                mimeType: "audio/wav",
                url: "https://example.com/voice.wav",
                isVoiceNote,
                durationMs: 8000,
                sizeBytes: 256044,
              },
            },
          ],
          options: {},
          inlinePlayback: false,
        }),
      { container },
    );
    onTestFinished(view.unmount);
    const player = container.querySelector("openclaw-chat-audio-player");
    if (isVoiceNote) {
      expect(player).toMatchObject({ voiceNote: true, serverDurationMs: 8000, sizeBytes: 256044 });
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
    } else {
      expect(player).toBeNull();
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
    }
  });
});
