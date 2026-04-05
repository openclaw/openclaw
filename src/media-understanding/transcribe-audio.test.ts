import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MullusiConfig } from "../config/config.js";

const { transcribeAudioFileFromRuntime } = vi.hoisted(() => {
  const transcribeAudioFileFromRuntime = vi.fn();
  return { transcribeAudioFileFromRuntime };
});

vi.mock("./runtime.js", () => ({
  transcribeAudioFile: transcribeAudioFileFromRuntime,
}));

import { transcribeAudioFile } from "./transcribe-audio.js";

describe("transcribeAudioFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards file transcription requests to the shared runtime helper", async () => {
    transcribeAudioFileFromRuntime.mockResolvedValue({ text: "hello" });

    const result = await transcribeAudioFile({
      filePath: "/tmp/note.mp3",
      cfg: {} as MullusiConfig,
    });

    expect(transcribeAudioFileFromRuntime).toHaveBeenCalledWith({
      filePath: "/tmp/note.mp3",
      cfg: {} as MullusiConfig,
    });
    expect(result).toEqual({ text: "hello" });
  });

  it("returns undefined when the runtime helper returns no transcript", async () => {
    transcribeAudioFileFromRuntime.mockResolvedValue({ text: undefined });

    const result = await transcribeAudioFile({
      filePath: "/tmp/missing.wav",
      cfg: {} as MullusiConfig,
    });

    expect(result).toEqual({ text: undefined });
  });

  it("propagates helper errors", async () => {
    const cfg = {
      tools: { media: { audio: { timeoutSeconds: 10 } } },
    } as unknown as MullusiConfig;
    transcribeAudioFileFromRuntime.mockRejectedValue(new Error("boom"));

    await expect(
      transcribeAudioFile({
        filePath: "/tmp/note.wav",
        cfg,
      }),
    ).rejects.toThrow("boom");
  });
});
