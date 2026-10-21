// Register dispatch fixtures before loading the real speech decision owner.
// oxfmt-ignore
import { ttsMocks } from "./dispatch-from-config.shared.test-harness.js";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as ttsConfig from "../../tts/tts-config.js";
import { maybeApplyTtsToPayloadCore } from "../../tts/tts-payload.js";
import * as ttsProviderResolution from "../../tts/tts-provider-resolution.js";
import * as ttsSynthesis from "../../tts/tts-synthesis.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  installCaptionedVoiceTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const audioPath = "https://example.com/good-night.opus";
const speech = "Good night, sleep well.";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  vi.stubEnv("OPENCLAW_TTS_PREFS", path.join(tempDirs.make("tagged-tts-"), "prefs.json"));
  ttsMocks.state.statusSnapshot.autoMode = "tagged";
  ttsMocks.resolveTtsConfig.mockImplementation((cfg) => ({ mode: cfg.tts?.mode ?? "final" }));
  ttsMocks.maybeApplyTtsToPayload.mockImplementation((params) =>
    maybeApplyTtsToPayloadCore(
      params as Parameters<typeof maybeApplyTtsToPayloadCore>[0],
      async () => audioPath,
    ),
  );
  vi.spyOn(ttsProviderResolution, "resolveTtsProviderAsync").mockResolvedValue("openai");
  vi.spyOn(ttsSynthesis, "textToSpeechCore").mockResolvedValue({
    success: true,
    audioPath,
    audioAsVoice: true,
    provider: "openai",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { channel: "telegram", mode: "final", canonical: false },
  { channel: "telegram", mode: "all", canonical: false },
  { channel: "discord", mode: "final", canonical: false },
  { channel: "telegram", mode: "final", canonical: true },
  { channel: "telegram", mode: "all", canonical: true },
] as const)(
  "delivers tagged block speech once on $channel in $mode mode (canonical final: $canonical)",
  async ({ channel, mode, canonical }) => {
    installCaptionedVoiceTestPlugin(channel);
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: channel, Surface: channel }),
      cfg: { tts: { auto: "tagged", mode, provider: "openai" } },
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        const pipeline = createBlockReplyPipeline({
          onBlockReply: (payload, context) => opts?.onBlockReply?.(payload, context),
          timeoutMs: 0,
        });
        try {
          for (const text of [
            "Welcome home.",
            "Rest well.",
            `[[tts:text]]${speech}[[/tts:text]]`,
          ]) {
            pipeline.enqueue({ text });
            await pipeline.flush({ force: true });
          }
        } finally {
          pipeline.stop();
        }
        const final = { text: "See you tomorrow." };
        return canonical
          ? setReplyPayloadMetadata(final, { tts: { tagged: true, text: speech } })
          : final;
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(ttsSynthesis.textToSpeechCore).toHaveBeenCalledOnce();
    expect(ttsSynthesis.textToSpeechCore).toHaveBeenCalledWith(
      expect.objectContaining({ text: speech, channel }),
      expect.any(Function),
    );
    expect(delivered.flatMap((payload) => (payload.text ? [payload.text] : []))).toEqual([
      "Welcome home.",
      "Rest well.",
      "See you tomorrow.",
    ]);
    expect(delivered.filter((payload) => payload.mediaUrl)).toEqual([
      expect.objectContaining({ mediaUrl: audioPath, audioAsVoice: true, spokenText: speech }),
    ]);
  },
);

it.each([true, false])(
  "does not replay all-mode block speech (directive parsing: %s)",
  async (enabled) => {
    ttsMocks.state.statusSnapshot.autoMode = "always";
    vi.spyOn(ttsConfig, "shouldCleanTtsDirectiveText").mockReturnValue(enabled);
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "telegram", Surface: "telegram" }),
      cfg: { tts: { auto: "always", mode: "all", modelOverrides: { enabled } } },
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        await opts?.onBlockReply?.({ text: "[[tts]]Welcome home.[[/tts]]" });
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(ttsSynthesis.textToSpeechCore).toHaveBeenCalledOnce();
    expect(delivered).toEqual([
      expect.objectContaining({ mediaUrl: audioPath, audioAsVoice: true }),
    ]);
  },
);
