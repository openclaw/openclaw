import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./chat-history-pages.js";
import { createReplyTranscriptFixture } from "./chat-send-reply-dispatch.test-support.js";

describe("runtime-owned TTS history", () => {
  it.each([
    {
      name: "captioned",
      audioOnly: false,
      rawText: "Visible answer. [[tts:text]]Speech only.[[/tts:text]]",
      previousDisplay: null,
      expectedText: "Visible answer.",
      splitTag: false,
    },
    {
      name: "audio-only",
      audioOnly: true,
      rawText: "Visible answer. [[tts:text]]Speech only.[[/tts:text]]",
      previousDisplay: null,
      expectedText: "Visible answer.",
      splitTag: false,
    },
    {
      name: "previous display caption",
      audioOnly: true,
      rawText: "Original answer. [[tts:text]]Speech only.[[/tts:text]]",
      previousDisplay: "Edited answer.",
      expectedText: "Edited answer.",
      splitTag: false,
    },
    {
      name: "split hidden-speech tag",
      audioOnly: true,
      rawText: "Visible answer. [[tts:text]]Speech only.[[/tts:text]]",
      previousDisplay: null,
      expectedText: "Visible answer.",
      splitTag: true,
    },
  ])("keeps $name and audio in reloaded history for runtime-owned TTS", async (scenario) => {
    await withOpenClawTestState({ label: "webchat-owned-tts" }, async () => {
      const { dispatch, append, scope } = await createReplyTranscriptFixture();
      const { audioOnly, rawText, previousDisplay, expectedText, splitTag } = scenario;
      const rawContent = splitTag
        ? [
            { type: "text", text: "Visible answer. [" },
            { type: "text", text: "[tts:text]]Speech only.[[/tts:text]]" },
          ]
        : [{ type: "text", text: rawText }];
      const idempotencyKey = "runtime-owned-tts";
      await dispatch.runAgentMediaTranscript(
        { run: async (operation) => operation() },
        async () => {
          dispatch.captureAgentTranscriptStart();
          await append("answer", {
            role: "assistant",
            idempotencyKey,
            content: rawContent,
            ...(previousDisplay
              ? { openclawDisplayContent: [{ type: "text", text: previousDisplay }] }
              : {}),
            stopReason: "stop",
          });
          const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
          dispatcher.sendFinalReply(
            setReplyPayloadMetadata(
              {
                ...(audioOnly ? {} : { text: expectedText }),
                spokenText: "Speech only.",
                mediaUrl: `data:audio/mpeg;base64,${createPlaybackMediaFixture("mp3").toString("base64")}`,
                ttsSupplement: {
                  spokenText: "Speech only.",
                  ...(audioOnly ? { visibleTextAlreadyDelivered: true } : {}),
                },
              },
              {
                assistantTranscriptOwned: true,
                assistantTranscriptIdempotencyKey: idempotencyKey,
              },
            ),
          );
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        },
      );

      const event = loadTranscriptEventsSync(scope).find(
        (entry) => asOptionalRecord(entry)?.id === "answer",
      );
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      expect(message?.content).toEqual(rawContent);
      const readHistory = () =>
        readChatHistoryPage({
          entry: { sessionId: scope.sessionId, updatedAt: 1 },
          provider: "openai",
          sessionId: scope.sessionId,
          storePath: scope.storePath,
          sessionAgentId: "main",
          canonicalKey: scope.sessionKey,
          max: 20,
          offset: undefined,
          maxHistoryBytes: 1_000_000,
          effectiveMaxChars: 10_000,
          messageId: undefined,
          ignoreCliSessionImports: true,
        });
      const history = await readHistory();
      expect(await readHistory()).toEqual(history);
      const displayed = JSON.stringify(
        history.messages.find((item) => asOptionalRecord(item)?.role === "assistant"),
      );
      expect(displayed).toContain(expectedText);
      expect(displayed).toContain('"type":"audio"');
      expect(displayed).not.toContain("Speech only.");
      expect(displayed).not.toContain("Audio reply");
    });
  });
});
