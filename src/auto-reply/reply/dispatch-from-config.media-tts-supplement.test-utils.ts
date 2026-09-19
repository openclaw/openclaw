// Imported by a dispatch-from-config entrypoint to keep its mocked suite in one Vitest module graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { getReplyPayloadTtsSupplement, setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { emptyConfig, ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { deliverFinalWithMedia } from "./dispatch-from-config.tts-guard.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

/**
 * The voice supplement for an answer that carries non-audio media: the core guard
 * keeps such a final silent, and this branch sends the voice as a second message.
 * Split out of `dispatch-from-config.delivery-and-tts.test-utils.ts` so neither file
 * grows past the repository's line cap.
 */
beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig media voice supplement", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    describe0BeforeEach0();
  });
  afterEach(clearRuntimeConfigSnapshot);

  // A final that carries media is never spoken by the core guard, whatever the media is.
  // The supplement branch therefore has to tell audio (already a voice) from everything
  // else (a picture, a document, a video), and it decides by the reference alone.
  const MEDIA_FORMAT_CASES: Array<{ label: string; media: string; speaks: boolean }> = [
    { label: "PNG picture", media: "https://example.com/chart.png", speaks: true },
    { label: "JPEG photo", media: "https://example.com/photo.jpg", speaks: true },
    {
      label: "JPEG URL with query",
      media: "https://example.com/photo.jpeg?token=abc",
      speaks: true,
    },
    { label: "WebP picture", media: "https://example.com/sticker.webp", speaks: true },
    { label: "GIF animation", media: "https://example.com/loop.gif", speaks: true },
    { label: "PDF document", media: "/tmp/report.pdf", speaks: true },
    { label: "MP4 video", media: "/tmp/clip.mp4", speaks: true },
    { label: "extensionless reference", media: "https://example.com/attachment", speaks: true },
    { label: "Opus voice note", media: "/tmp/note.opus", speaks: false },
    { label: "Ogg audio", media: "/tmp/note.ogg", speaks: false },
    { label: "Oga audio", media: "/tmp/note.oga", speaks: false },
    { label: "MP3 audio", media: "/tmp/song.mp3", speaks: false },
    { label: "M4A audio", media: "/tmp/song.m4a", speaks: false },
    { label: "WAV audio", media: "/tmp/take.wav", speaks: false },
    { label: "FLAC audio", media: "/tmp/take.flac", speaks: false },
    { label: "AAC audio", media: "/tmp/take.aac", speaks: false },
    { label: "Opus URL with query", media: "https://example.com/voice.opus?sig=1", speaks: false },
    { label: "uppercase JPG", media: "/tmp/PHOTO.JPG", speaks: true },
    { label: "uppercase OPUS", media: "/tmp/NOTE.OPUS", speaks: false },
    // The shared media table owns these, so the branch inherits its verdicts instead of
    // keeping a second list that drifts: .caf is an iMessage voice memo, .webm is video.
    { label: "CAF voice memo", media: "/tmp/memo.caf", speaks: false },
    { label: "M4B audiobook", media: "/tmp/book.m4b", speaks: false },
    { label: "AIFC audio", media: "/tmp/take.aifc", speaks: false },
    { label: "M2A audio", media: "/tmp/take.m2a", speaks: false },
    { label: "WebM video", media: "/tmp/clip.webm", speaks: true },
    // A local path may carry the very characters a URL uses for query and fragment.
    { label: "local path with #", media: "/tmp/track #1.mp3", speaks: false },
    { label: "local path with ?", media: "/tmp/why? .m4a", speaks: false },
  ];

  it.each(MEDIA_FORMAT_CASES)(
    "$label: voice supplement follows = $speaks",
    async ({ media, speaks }) => {
      setNoAbort();
      ttsMocks.state.synthesizeFinalAudio = true;
      const delivered = await deliverFinalWithMedia({
        text: "Here is what you asked for.",
        mediaUrl: media,
      });

      // The visible answer always survives untouched — that is the whole point of the guard.
      expect(delivered[0]).toEqual({
        kind: "final",
        payload: expect.objectContaining({ text: "Here is what you asked for.", mediaUrl: media }),
      });
      expect(delivered).toHaveLength(speaks ? 2 : 1);
      if (speaks) {
        expect(delivered[1]).toEqual({
          kind: "final",
          payload: expect.objectContaining({
            text: undefined,
            mediaUrl: "https://example.com/tts-synth.opus",
            audioAsVoice: true,
          }),
        });
      }
    },
  );

  it("speaks a multi-attachment answer once when any attachment is not audio", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "Two pictures and a recording.",
      mediaUrls: ["/tmp/a.png", "/tmp/b.jpg", "/tmp/c.opus"],
    });

    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.payload).toEqual(
      expect.objectContaining({ text: undefined, mediaUrl: "https://example.com/tts-synth.opus" }),
    );
  });

  it("stays silent for an audio-only multi-attachment answer", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "Two recordings.",
      mediaUrls: ["/tmp/a.opus", "/tmp/b.mp3"],
    });

    expect(delivered).toHaveLength(1);
  });

  it("has nothing to speak for a caption-less picture", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({ mediaUrl: "/tmp/chart.png" });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toEqual(expect.objectContaining({ mediaUrl: "/tmp/chart.png" }));
  });

  it("leaves an error payload with media unspoken", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "Something went wrong while drawing that.",
      mediaUrl: "/tmp/chart.png",
      isError: true,
    });

    expect(delivered).toHaveLength(1);
  });

  it("keeps the supplement out of non-final TTS modes", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "all" });
    const delivered = await deliverFinalWithMedia({
      text: "Here is what you asked for.",
      mediaUrl: "/tmp/chart.png",
    });

    expect(delivered).toHaveLength(1);
  });

  it("speaks each picture answer when a turn ends with several finals", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => [
        { text: "First chart.", mediaUrl: "/tmp/first.png" },
        { text: "Second chart.", mediaUrl: "/tmp/second.png" },
      ],
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // Both pictures land first, in source order; their voices follow afterwards.
    expect(delivered.map(({ payload }) => payload.mediaUrl)).toEqual([
      "/tmp/first.png",
      "/tmp/second.png",
      "https://example.com/tts-synth.opus",
      "https://example.com/tts-synth.opus",
    ]);
    expect(delivered.slice(2).every(({ payload }) => payload.text === undefined)).toBe(true);
  });

  it("speaks the streamed answer too when the final that ends it carries a picture", async () => {
    setNoAbort();
    installCaptionedVoiceTestPlugin("telegram");
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "Streamed part of the answer." });
      return { text: "And the chart itself.", mediaUrl: "/tmp/chart.png" };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The streamed text is held for the caption on this channel, so the picture message
    // carries the whole answer — and the voice that follows says the whole answer too.
    const finals = delivered.filter(({ kind }) => kind === "final");
    expect(finals).toHaveLength(2);
    expect(finals[0]?.payload.mediaUrl).toBe("/tmp/chart.png");
    expect(finals[1]?.payload).toEqual(
      expect.objectContaining({
        text: undefined,
        mediaUrl: "https://example.com/tts-synth.opus",
      }),
    );
    expect(
      getReplyPayloadTtsSupplement(expectDefined(finals[1]?.payload, "voice supplement"))
        ?.spokenText,
    ).toContain("Streamed part of the answer.");
  });

  it("keeps a command reply with media silent, as the core guard intends", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia(
      setReplyPayloadMetadata(
        { text: "Here is the context map you asked for.", mediaUrl: "/tmp/context-map.png" },
        { commandReply: true },
      ),
    );

    // Command replies never auto-speak. Re-synthesizing from a bare { text } payload
    // would lose that metadata and hand the user an unwanted voice note.
    expect(delivered).toHaveLength(1);
  });

  it("speaks a command reply with media when speech was requested explicitly", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia(
      setReplyPayloadMetadata(
        { text: "Here is the context map you asked for.", mediaUrl: "/tmp/context-map.png" },
        { commandReply: true, ttsExplicit: true },
      ),
    );

    expect(delivered).toHaveLength(2);
    // The picture must survive: an explicit speech request adds a voice, it does not
    // replace the attachment with one.
    expect(delivered[0]?.payload).toEqual(
      expect.objectContaining({
        text: "Here is the context map you asked for.",
        mediaUrl: "/tmp/context-map.png",
      }),
    );
    expect(delivered[1]?.payload.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("speaks an answer whose picture arrives as a legacy MEDIA: line", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "Here is the chart you asked for.\nMEDIA: /tmp/chart.png",
    });

    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.payload.text).toBe(
      "Here is the chart you asked for.\nMEDIA: /tmp/chart.png",
    );
    // The directive is stripped from the spoken copy: keeping it would re-trigger the
    // very guard this branch exists to compensate for, and nobody wants "MEDIA colon"
    // read out loud either.
    expect(
      getReplyPayloadTtsSupplement(expectDefined(delivered[1]?.payload, "voice supplement"))
        ?.spokenText,
    ).toBe("Here is the chart you asked for.");
  });

  it.each([
    {
      label: "directive on its own line",
      text: "Here is the chart.\nMEDIA: /tmp/chart.png\nIt shows the weekly totals.",
      spoken: "Here is the chart.\n\nIt shows the weekly totals.",
    },
    {
      label: "directive between paragraphs",
      text: "Here is the chart.\n\nMEDIA: /tmp/chart.png\n\nIt shows the weekly totals.",
      spoken: "Here is the chart.\n\nIt shows the weekly totals.",
    },
  ])("leaves no hole where a MEDIA: line was stripped ($label)", async ({ text, spoken }) => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({ text });

    // The directive keeps its place in the visible message and only leaves the
    // spoken copy; what remains reads as one answer, not as text with a gap.
    expect(delivered).toHaveLength(2);
    expect(
      getReplyPayloadTtsSupplement(expectDefined(delivered[1]?.payload, "voice supplement"))
        ?.spokenText,
    ).toBe(spoken);
  });

  it("stays silent when the legacy MEDIA: line points at audio", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "Listen to this.\nMEDIA: /tmp/note.opus",
    });

    expect(delivered).toHaveLength(1);
  });

  it("trusts an explicit voice-note flag over an unreadable media reference", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered = await deliverFinalWithMedia({
      text: "The recording you asked for.",
      mediaUrl: "media://5f2c1a",
      audioAsVoice: true,
    });

    // A store reference carries no extension, so only the payload's own flag can say
    // this answer already speaks.
    expect(delivered).toHaveLength(1);
  });
});
