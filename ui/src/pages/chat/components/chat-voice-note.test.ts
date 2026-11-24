/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";

describe("incoming audio presentation", () => {
  it.each([true, false, undefined])(
    "keeps incoming audio inline regardless of voice-note metadata (%s)",
    (isVoiceNote) => {
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
      expect(player).toMatchObject({
        voiceNote: isVoiceNote === true,
        serverDurationMs: 8000,
        sizeBytes: 256044,
      });
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
    },
  );

  it.each(["document", "video"] as const)("keeps incoming %s attachments as cards", (kind) => {
    const view = mountSolid(() =>
      createComponent(AssistantAttachments, {
        attachments: [
          {
            type: "attachment",
            attachment: { kind, label: "attachment", url: "https://example.com/file" },
          },
        ],
        options: {},
        inlinePlayback: false,
      }),
    );
    onTestFinished(view.unmount);
    expect(view.container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
    expect(
      view.container.querySelector("openclaw-chat-audio-player, openclaw-chat-video-player"),
    ).toBeNull();
  });
});
