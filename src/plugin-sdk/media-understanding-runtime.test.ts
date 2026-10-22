import { describe, expect, it, vi } from "vitest";
import {
  createChannelPreflightAudio,
  formatAudioTranscriptForAgent,
} from "./media-understanding-runtime.js";

type TranscribeFirstAudio =
  typeof import("../media-understanding/audio-preflight.js").transcribeFirstAudio;
type SendTranscriptEcho =
  typeof import("../media-understanding/echo-transcript.js").sendTranscriptEcho;

const audioConfig = {
  tools: { media: { audio: { echoTranscript: true, echoFormat: "heard: {transcript}" } } },
};
const request = { ctx: { media: [] }, cfg: {} };
const echo = {
  transcript: "cost is $& and $1",
  cfg: audioConfig,
  accountId: "work",
  originatingTo: "channel:C1",
  messageThreadId: "thread-1",
};
const createPreflight = (
  overrides: Partial<Parameters<typeof createChannelPreflightAudio<{ contentType?: string }>>[0]>,
) => createChannelPreflightAudio({ channel: "test", isAudio: () => true, ...overrides });

describe("formatAudioTranscriptForAgent", () => {
  it("labels and escapes machine-generated transcripts", () => {
    expect(formatAudioTranscriptForAgent('say "hi"\nthen go')).toBe(
      '[Audio transcript (machine-generated, untrusted)]: "say \\"hi\\"\\nthen go"',
    );
  });
});

describe("createChannelPreflightAudio", () => {
  it("suppresses speculative echo without mutating the caller config", async () => {
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>().mockResolvedValue("hello");
    const preflight = createPreflight({ transcribeFirstAudio });
    const audioRequest = {
      ctx: { media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }] },
      cfg: audioConfig,
    };
    await expect(preflight.resolve({ request: audioRequest })).resolves.toBe("hello");

    expect(transcribeFirstAudio).toHaveBeenCalledWith({
      ctx: audioRequest.ctx,
      cfg: {
        tools: { media: { audio: { echoTranscript: false, echoFormat: "heard: {transcript}" } } },
      },
    });
    expect(audioConfig.tools.media.audio.echoTranscript).toBe(true);
  });

  it("preserves the original config for channels without deferred echo", async () => {
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>().mockResolvedValue("hello");
    const preflight = createPreflight({ deferTranscriptEcho: false, transcribeFirstAudio });

    await preflight.resolve({ request: { ctx: { media: [] }, cfg: audioConfig } });

    expect(transcribeFirstAudio).toHaveBeenCalledWith({ ctx: { media: [] }, cfg: audioConfig });
  });

  it("checks abort state before and after transcription", async () => {
    const before = new AbortController();
    before.abort();
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>();
    const preflight = createPreflight({ transcribeFirstAudio });

    await expect(
      preflight.resolve({ request, abortSignal: before.signal }),
    ).resolves.toBeUndefined();
    expect(transcribeFirstAudio).not.toHaveBeenCalled();

    const after = new AbortController();
    transcribeFirstAudio.mockImplementation(async () => {
      after.abort();
      return "too late";
    });
    await expect(
      preflight.resolve({ request, abortSignal: after.signal }),
    ).resolves.toBeUndefined();
  });

  it("formats and sends admitted echoes while preserving literal replacement tokens", async () => {
    const sendTranscriptEcho = vi.fn<SendTranscriptEcho>().mockResolvedValue(undefined);
    const preflight = createPreflight({ sendTranscriptEcho });

    expect(preflight.format("cost is $& and $1", "heard: {transcript}")).toBe(
      "heard: cost is $& and $1",
    );
    await preflight.send(echo);

    expect(sendTranscriptEcho).toHaveBeenCalledWith({
      ctx: {
        Provider: "test",
        Surface: "test",
        OriginatingChannel: "test",
        OriginatingTo: "channel:C1",
        AccountId: "work",
        MessageThreadId: "thread-1",
      },
      cfg: audioConfig,
      transcript: "cost is $& and $1",
      format: "heard: {transcript}",
      logSuccess: false,
      failureLogPrefix: "test: audio transcript echo failed",
    });
  });

  it("does not send when echo is disabled", async () => {
    const sendTranscriptEcho = vi.fn<SendTranscriptEcho>();
    const preflight = createPreflight({ sendTranscriptEcho });
    await preflight.send({ ...echo, transcript: "hello", cfg: {} });

    expect(sendTranscriptEcho).not.toHaveBeenCalled();
  });
});
