import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_AUDIO_TRANSCRIPT_PLACEHOLDER } from "./audio-preflight.js";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

let transcribeFirstAudio: typeof import("./audio-preflight.js").transcribeFirstAudio;

describe("transcribeFirstAudio", () => {
  const enabledCfg = {
    tools: {
      media: {
        audio: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;

  const ctx: MsgContext = {
    Body: "<media:audio>",
    MediaPath: "/tmp/voice.ogg",
    MediaType: "audio/ogg",
  };

  beforeAll(async () => {
    ({ transcribeFirstAudio } = await import("./audio-preflight.js"));
  });

  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    const transcript = await transcribeFirstAudio({
      ctx,
      cfg: {},
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx,
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

  it("returns a clear placeholder when tiny audio is skipped", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: undefined,
      attachments: [],
      skippedReason: "tooSmall",
    });

    await expect(transcribeFirstAudio({ ctx, cfg: enabledCfg })).resolves.toBe(
      EMPTY_AUDIO_TRANSCRIPT_PLACEHOLDER,
    );
  });

  it("returns a clear placeholder when empty audio is skipped", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: undefined,
      attachments: [],
      skippedReason: "empty",
    });

    await expect(transcribeFirstAudio({ ctx, cfg: enabledCfg })).resolves.toBe(
      EMPTY_AUDIO_TRANSCRIPT_PLACEHOLDER,
    );
  });

  it("keeps returning undefined for non-empty skip reasons", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: undefined,
      attachments: [],
      skippedReason: "timeout",
    });

    await expect(transcribeFirstAudio({ ctx, cfg: enabledCfg })).resolves.toBeUndefined();
  });

  it("returns the actual transcript when transcription succeeds", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from audio",
      attachments: [],
    });

    await expect(transcribeFirstAudio({ ctx, cfg: enabledCfg })).resolves.toBe("hello from audio");
  });
});
