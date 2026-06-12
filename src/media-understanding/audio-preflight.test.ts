// Audio preflight tests cover auto mode, explicit disable, and transcript echo
// delivery settings.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeFirstAudio, transcribeFirstAudioWithTelemetry } from "./audio-preflight.js";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());
const sendTranscriptEchoMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

vi.mock("./echo-transcript.js", () => ({
  DEFAULT_ECHO_TRANSCRIPT_FORMAT: '📝 "{transcript}"',
  sendTranscriptEcho: (...args: unknown[]) => sendTranscriptEchoMock(...args),
}));

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
    sendTranscriptEchoMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(transcript).toBeUndefined();
    expect(runAudioTranscriptionMock).not.toHaveBeenCalled();
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("echoes the preflight transcript when echoTranscript is enabled", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from dm audio",
      attachments: [],
    });

    const ctx = {
      Body: "<media:audio>",
      Provider: "telegram",
      OriginatingTo: "telegram:42",
      AccountId: "default",
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg",
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

  it("returns transcript telemetry with provider/model/baseUrl and transcript hash", async () => {
    const transcript = "voice note transcript";
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript,
      attachments: [],
      output: {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: transcript,
        provider: "openai",
        model: "whisper-1",
        baseUrl: "https://stt.example.test/v1",
      },
      decision: {
        capability: "audio",
        outcome: "success",
        attachments: [
          {
            attachmentIndex: 0,
            attempts: [
              {
                type: "provider",
                provider: "openai",
                model: "whisper-1",
                outcome: "success",
              },
            ],
          },
        ],
      },
    });

    const result = await transcribeFirstAudioWithTelemetry({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(result?.transcript).toBe(transcript);
    expect(result?.telemetry).toMatchObject({
      status: "success",
      provider: "openai",
      model: "whisper-1",
      baseUrl: "https://stt.example.test/v1",
      transcript: {
        length: transcript.length,
        sha256: createHash("sha256").update(transcript).digest("hex"),
        trusted: false,
        truncated: false,
        enteredAgentContext: false,
      },
    });
    expect(result?.telemetry.durationMs).toEqual(expect.any(Number));
  });

  it("marks truncated preflight transcripts in telemetry", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "partial transcript",
      attachments: [],
      output: {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: "partial transcript",
        provider: "openai",
        model: "whisper-1",
        truncated: true,
      },
      decision: {
        capability: "audio",
        outcome: "success",
        attachments: [],
      },
    });

    const result = await transcribeFirstAudioWithTelemetry({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(result?.transcript).toBe("partial transcript");
    expect(result?.telemetry).toMatchObject({
      status: "truncated",
      transcript: {
        length: "partial transcript".length,
        trusted: false,
        truncated: true,
        enteredAgentContext: false,
      },
    });
  });

  it("returns timeout telemetry when preflight STT throws", async () => {
    const err = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    runAudioTranscriptionMock.mockRejectedValueOnce(err);

    const result = await transcribeFirstAudioWithTelemetry({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(result?.transcript).toBeUndefined();
    expect(result?.telemetry).toMatchObject({
      status: "timeout",
      errorClass: "TimeoutError",
      transcript: {
        length: 0,
        trusted: false,
        truncated: false,
        enteredAgentContext: false,
      },
    });
  });
});
