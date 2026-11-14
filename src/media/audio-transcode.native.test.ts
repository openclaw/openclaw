import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { transcodeAudioBuffer } from "./audio-transcode.js";
import { resolveFfmpegBin } from "./ffmpeg-exec.js";

// Native regression requires macOS conversion tools and FFmpeg.
function hasFfmpeg(): boolean {
  try {
    execFileSync(resolveFfmpegBin(), ["-version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Synthetic ten-segment reproduction, not speech or private user audio.
it.skipIf(process.platform !== "darwin" || !hasFfmpeg())(
  "preserves decoded frames of the ten-segment MP3 in Opus CAF",
  async () => {
    const fixture = await readFile(new URL("./fixtures/tts-ten-segment.mp3", import.meta.url));
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(
      "7b2d8a3b1244383a4cfc3beaa57ba756c0d76c7d485fa80f927a458bdb60c0f0",
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "caf-frame-regression-"));
    try {
      const input = path.join(dir, "input.mp3");
      const output = path.join(dir, "output.caf");
      await writeFile(input, fixture);
      const decode = (file: string) =>
        execFileSync(
          resolveFfmpegBin(),
          ["-nostdin", "-v", "error", "-i", file, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"],
          { maxBuffer: 8 * 1024 * 1024 },
        ).length / 2;
      const expected = decode(input);
      expect(expected).toBe(1_153_775);
      const result = await transcodeAudioBuffer({
        audioBuffer: fixture,
        sourceExtension: "mp3",
        targetExtension: "caf",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.detail);
      }
      await writeFile(output, result.buffer);
      const actual = decode(output);
      console.log(
        JSON.stringify({
          expectedFrames: expected,
          decodedCafFrames: actual,
          expectedSeconds: expected / 24000,
          actualSeconds: actual / 24000,
        }),
      );
      // Decoder exposes encoder padding; allow < one 20ms Opus packet.
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(480);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
