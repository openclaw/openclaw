import { expect, it, vi } from "vitest";
import {
  createChannelPreflightAudio,
  formatAudioTranscriptForAgent,
} from "./media-understanding-runtime.js";

type TranscribeFirstAudio =
  typeof import("../media-understanding/audio-preflight.js").transcribeFirstAudio;
type SendTranscriptEcho =
  typeof import("../media-understanding/echo-transcript.js").sendTranscriptEcho;

const audio = { echoTranscript: true, echoFormat: "heard: {transcript}" };
const audioConfig = { tools: { media: { audio } } };
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

it("labels and escapes machine-generated transcripts", () => {
  expect(formatAudioTranscriptForAgent('say "hi"\nthen go')).toBe(
    '[Audio transcript (machine-generated, untrusted)]: "say \\"hi\\"\\nthen go"',
  );
});

it.each([undefined, false])(
  "defers speculative echo=%s without mutating config",
  async (deferTranscriptEcho) => {
    const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>().mockResolvedValue("hello");
    const preflight = createPreflight({ deferTranscriptEcho, transcribeFirstAudio });
    const audioRequest = { ...request, cfg: audioConfig };
    await expect(preflight.resolve({ request: audioRequest })).resolves.toBe("hello");

    const received = transcribeFirstAudio.mock.calls[0]?.[0];
    expect(received?.ctx).toBe(audioRequest.ctx);
    expect(received?.cfg.tools?.media?.audio).toEqual({
      ...audio,
      echoTranscript: deferTranscriptEcho === false,
    });
    expect(audioConfig.tools.media.audio.echoTranscript).toBe(true);
  },
);

it.each(["before", "during"])("checks abort state %s transcription", async (stage) => {
  const controller = new AbortController();
  const transcribeFirstAudio = vi.fn<TranscribeFirstAudio>(async () => {
    controller.abort();
    return "too late";
  });
  if (stage === "before") {
    controller.abort();
  }
  const preflight = createPreflight({ transcribeFirstAudio });
  await expect(
    preflight.resolve({ request, abortSignal: controller.signal }),
  ).resolves.toBeUndefined();
  expect(transcribeFirstAudio).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
});

it("formats and sends admitted echoes while preserving literal replacement tokens", async () => {
  const sendTranscriptEcho = vi.fn<SendTranscriptEcho>().mockResolvedValue(undefined);
  const preflight = createPreflight({ sendTranscriptEcho });

  expect(preflight.format("cost is $& and $1", "heard: {transcript}")).toBe(
    "heard: cost is $& and $1",
  );
  await preflight.send(echo);

  expect(sendTranscriptEcho.mock.calls[0]?.[0]).toMatchObject({
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
  });
});

it("does not send when echo is disabled", async () => {
  const sendTranscriptEcho = vi.fn<SendTranscriptEcho>();
  const preflight = createPreflight({ sendTranscriptEcho });
  await preflight.send({ ...echo, transcript: "hello", cfg: {} });

  expect(sendTranscriptEcho).not.toHaveBeenCalled();
});
