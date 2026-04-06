import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

let transcribeFirstAudio: typeof import("./audio-preflight.js").transcribeFirstAudio;
let transcribeFirstAudioResult: typeof import("./audio-preflight.js").transcribeFirstAudioResult;

describe("transcribeFirstAudio", () => {
  beforeAll(async () => {
    ({ transcribeFirstAudio, transcribeFirstAudioResult } = await import("./audio-preflight.js"));
  });

  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachmentIndex: 0,
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
  });

  it("returns the actual attachment index chosen by media understanding", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachmentIndex: 1,
      attachments: [
        { index: 0, path: "/tmp/voice-a.ogg", mime: "audio/ogg" },
        { index: 1, path: "/tmp/voice-b.ogg", mime: "audio/ogg" },
      ],
    });

    const result = await transcribeFirstAudioResult({
      ctx: {
        Body: "<media:audio>",
        MediaPaths: ["/tmp/voice-a.ogg", "/tmp/voice-b.ogg"],
        MediaTypes: ["audio/ogg", "audio/ogg"],
      },
      cfg: {
        tools: {
          media: {
            audio: {
              attachments: { prefer: "last" },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      transcript: "voice note transcript",
      attachmentIndex: 1,
    });
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
  });
});
