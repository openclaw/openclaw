import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { transcribeAudioAttachments, transcribeFirstAudio } from "./audio-preflight.js";

const runCapabilityMock = vi.hoisted(() => vi.fn());
const sendTranscriptEchoMock = vi.hoisted(() => vi.fn());
const voice = { path: "/tmp/voice.ogg", contentType: "audio/ogg" };
const voiceContext = () => ({ Body: "<media:audio>", media: [{ ...voice }] });
function transcriptOutput(text: string) {
  runCapabilityMock.mockResolvedValueOnce({ outputs: [{ kind: "audio.transcription", text }] });
}

vi.mock("./runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runner.js")>()),
  buildProviderRegistry: () => new Map(),
  runCapability: (...args: unknown[]) => runCapabilityMock(...args),
}));

vi.mock("./echo-transcript.js", () => ({
  DEFAULT_ECHO_TRANSCRIPT_FORMAT: '📝 "{transcript}"',
  sendTranscriptEcho: (...args: unknown[]) => sendTranscriptEchoMock(...args),
}));

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    runCapabilityMock.mockReset();
    sendTranscriptEchoMock.mockReset();
  });

  it.each<{ media: MsgContext["media"] }>([
    {
      media: [{ path: "/tmp/photo.jpg", contentType: "image/jpeg" }, { ...voice }],
    },
    { media: [{ path: "/tmp/voice.aiff" }] },
    {
      media: [
        {
          url: "https://cdn.example.test/download/opaque",
          fileName: "voice.ogg",
          contentType: "application/octet-stream",
        },
      ],
    },
  ])("recognizes audio in auto mode: $media", async ({ media }) => {
    transcriptOutput("voice note transcript");
    const ctx: MsgContext = { Body: "<media:audio>", media };
    await expect(transcribeFirstAudio({ ctx, cfg: {} })).resolves.toBe("voice note transcript");
    expect(runCapabilityMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
    expect(ctx.media?.at(-1)?.transcribed).toBe(true);
    if (media && media.length > 1) {
      expect(ctx.media?.[0]?.transcribed).not.toBe(true);
    }
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: voiceContext(),
      cfg: { tools: { media: { audio: { enabled: false } } } },
    });

    expect(transcript).toBeUndefined();
    expect(runCapabilityMock).not.toHaveBeenCalled();
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("echoes the preflight transcript when echoTranscript is enabled", async () => {
    transcriptOutput("hello from dm audio");

    const ctx = {
      ...voiceContext(),
      Provider: "telegram",
      OriginatingTo: "telegram:42",
      AccountId: "default",
    };
    const cfg = {
      tools: {
        media: {
          audio: {
            enabled: true,
            echoTranscript: true,
            echoFormat: "Heard: {transcript}",
          },
        },
      },
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg });

    expect(transcript).toBe("hello from dm audio");
    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
    expect(sendTranscriptEchoMock).toHaveBeenCalledWith({
      ctx,
      cfg,
      transcript: "hello from dm audio",
      format: "Heard: {transcript}",
    });
  });

  it("retains quoted audio in the transcript without echoing it", async () => {
    transcriptOutput("quoted voice context");
    const ctx: MsgContext = {
      Body: "follow-up",
      media: [{ ...voice, source: "quote" }],
    };
    await expect(
      transcribeFirstAudio({ ctx, cfg: { tools: { media: { audio: { echoTranscript: true } } } } }),
    ).resolves.toBe("quoted voice context");
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
    expect(ctx.media?.[0]).toMatchObject({ source: "quote", transcribed: true });
  });

  it("keeps a quoted first audio at its original nonzero index", async () => {
    transcriptOutput("quoted voice context");
    const ctx: MsgContext = {
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { ...voice, source: "quote" },
      ],
    };
    await expect(
      transcribeFirstAudio({ ctx, cfg: { tools: { media: { audio: { echoTranscript: true } } } } }),
    ).resolves.toBe("quoted voice context");
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
    expect(ctx.media?.[0]?.transcribed).not.toBe(true);
    expect(ctx.media?.[1]).toMatchObject({ source: "quote", transcribed: true });
  });

  it("echoes only current audio when preflight transcribes a mixed selection", async () => {
    runCapabilityMock.mockResolvedValueOnce({
      outputs: [
        { kind: "audio.transcription", attachmentIndex: 0, text: "current words" },
        { kind: "audio.transcription", attachmentIndex: 1, text: "quoted words" },
      ],
      decision: { capability: "audio", outcome: "success", attachments: [] },
    });
    const ctx: MsgContext = { media: [{ ...voice }, { ...voice, source: "quote" }] };
    const result = await transcribeAudioAttachments({
      ctx,
      cfg: { tools: { media: { audio: { echoTranscript: true } } } },
    });
    expect(result).toContain("current words");
    expect(result).toContain("quoted words");
    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
    expect(sendTranscriptEchoMock.mock.calls[0]?.[0].transcript).toBe("current words");
  });
});
