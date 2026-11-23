import { expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createTestTranscript, renderChatView } from "./chat-view.test-helpers.ts";
import { installTranscriptDomMocks } from "./components/chat-transcript.test-support.ts";

it("shows voice guidance only on the recording with a captured key failure", async () => {
  installTranscriptDomMocks();
  const transcript = createTestTranscript();
  try {
    const audio = {
      contentType: "audio/wav",
      path: "media://inbound/recording.wav",
      fileName: "recording.wav",
    };
    const container = renderChatView({
      transcript,
      messages: [
        {
          role: "user",
          content: "Earlier recording",
          __openclaw: { media: [{ ...audio, transcribed: true }] },
        },
        {
          role: "user",
          content: "Recording with a captured failure",
          __openclaw: { media: [audio], audioApiKeyRequired: "openai" },
        },
      ],
    });
    await waitForSolid(() => {
      const bubbles = [...container.querySelectorAll(".chat-bubble")];
      const earlier = bubbles.find((bubble) => bubble.textContent?.includes("Earlier recording"));
      const failed = bubbles.find((bubble) =>
        bubble.textContent?.includes("Recording with a captured failure"),
      );
      expect(earlier?.textContent).toBeDefined();
      expect(earlier?.textContent).not.toContain("transcribe this recording");
      expect(failed?.textContent).toContain(
        "Couldn’t transcribe this recording. It needs an OpenAI API key.",
      );
    });
  } finally {
    transcript.dispose();
  }
});
