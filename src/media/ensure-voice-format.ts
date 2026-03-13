import crypto from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { parseFfprobeCodecAndSampleRate, runFfmpeg, runFfprobe } from "./ffmpeg-exec.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "./ffmpeg-limits.js";

/** Sample rate Discord (and most voice-bubble channels) expect for Opus audio */
export const VOICE_OPUS_SAMPLE_RATE_HZ = 48_000;

/**
 * Convert an audio file to OGG/Opus format suitable for voice-bubble delivery.
 *
 * Returns the original path unchanged (cleanup = false) when the file is already
 * OGG/Opus at the expected sample rate.  Otherwise transcodes to a new temp file
 * (cleanup = true) which the caller is responsible for deleting.
 *
 * Callers must only pass local file paths — not URLs or protocol strings.
 */
export async function ensureVoiceFormat(
  filePath: string,
): Promise<{ path: string; cleanup: boolean }> {
  const trimmed = filePath.trim();
  // Defense-in-depth: reject URL/protocol strings before handing to ffmpeg.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `ensureVoiceFormat requires a local file path; received a URL/protocol source: ${trimmed}`,
    );
  }

  const ext = path.extname(filePath).toLowerCase();

  // Fast-path: already OGG — check codec and sample rate.
  if (ext === ".ogg") {
    try {
      const stdout = await runFfprobe([
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate",
        "-of",
        "csv=p=0",
        filePath,
      ]);
      const { codec, sampleRateHz } = parseFfprobeCodecAndSampleRate(stdout);
      if (codec === "opus" && sampleRateHz === VOICE_OPUS_SAMPLE_RATE_HZ) {
        return { path: filePath, cleanup: false };
      }
    } catch {
      // If probe fails, convert anyway.
    }
  }

  // Transcode to OGG/Opus at the expected sample rate.
  // Always resample to 48 kHz — lower rates (e.g. 24 kHz from some TTS providers)
  // cause 0.5× playback speed on channels that hard-code 48 kHz decoding.
  // Write into a temp subdirectory so callers can use scheduleCleanup(dir).
  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(tempRoot, "voice-fmt-"));
  const outputPath = path.join(tempDir, `voice-${crypto.randomUUID()}.ogg`);

  await runFfmpeg([
    "-y",
    "-i",
    filePath,
    "-vn",
    "-sn",
    "-dn",
    "-t",
    String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
    "-ar",
    String(VOICE_OPUS_SAMPLE_RATE_HZ),
    "-c:a",
    "libopus",
    "-b:a",
    "64k",
    outputPath,
  ]);

  return { path: outputPath, cleanup: true };
}
