/**
 * Discord Voice Message Support
 *
 * Implements sending voice messages via Discord's API.
 * Voice messages require:
 * - OGG/Opus format audio
 * - Waveform data (base64 encoded, up to 256 samples, 0-255 values)
 * - Duration in seconds
 * - Message flag 8192 (IS_VOICE_MESSAGE)
 * - No other content (text, embeds, etc.)
 */

import type { RequestClient } from "@buape/carbon";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RetryRunner } from "../infra/retry-policy.js";

const execFileAsync = promisify(execFile);

const DISCORD_VOICE_MESSAGE_FLAG = 8192;
const WAVEFORM_SAMPLES = 256;

export type VoiceMessageMetadata = {
  durationSecs: number;
  waveform: string; // base64 encoded
};

/**
 * Get audio duration using ffprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const duration = parseFloat(stdout.trim());
    if (isNaN(duration)) {
      throw new Error("Could not parse duration");
    }
    return Math.round(duration * 100) / 100; // Round to 2 decimal places
  } catch (err) {
    throw new Error(`Failed to get audio duration: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Generate waveform data from audio file using ffmpeg
 * Returns base64 encoded byte array of amplitude samples (0-255)
 */
export async function generateWaveform(filePath: string): Promise<string> {
  try {
    // Use ffmpeg to extract raw audio samples and compute amplitudes
    // We'll get the peak amplitude for each segment of the audio
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-i",
        filePath,
        "-af",
        `aresample=8000,asetnsamples=n=${WAVEFORM_SAMPLES}:p=0,astats=metadata=1:reset=1`,
        "-f",
        "null",
        "-",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 },
    );

    // Fallback: generate a simple waveform by sampling the audio
    // This is a simplified approach - extract raw PCM and sample it
    const waveformData = await generateWaveformFromPcm(filePath);
    return waveformData;
  } catch {
    // If ffmpeg approach fails, generate a placeholder waveform
    return generatePlaceholderWaveform();
  }
}

/**
 * Generate waveform by extracting raw PCM data and sampling amplitudes
 */
async function generateWaveformFromPcm(filePath: string): Promise<string> {
  const tempDir = os.tmpdir();
  const tempPcm = path.join(tempDir, `waveform-${Date.now()}.raw`);

  try {
    // Convert to raw 16-bit signed PCM, mono, 8kHz
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      filePath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "8000",
      tempPcm,
    ]);

    const pcmData = await fs.readFile(tempPcm);
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);

    // Sample the PCM data to get WAVEFORM_SAMPLES points
    const step = Math.max(1, Math.floor(samples.length / WAVEFORM_SAMPLES));
    const waveform: number[] = [];

    for (let i = 0; i < WAVEFORM_SAMPLES && i * step < samples.length; i++) {
      // Get average absolute amplitude for this segment
      let sum = 0;
      let count = 0;
      for (let j = 0; j < step && i * step + j < samples.length; j++) {
        sum += Math.abs(samples[i * step + j]!);
        count++;
      }
      const avg = count > 0 ? sum / count : 0;
      // Normalize to 0-255 (16-bit signed max is 32767)
      const normalized = Math.min(255, Math.round((avg / 32767) * 255));
      waveform.push(normalized);
    }

    // Pad with zeros if we don't have enough samples
    while (waveform.length < WAVEFORM_SAMPLES) {
      waveform.push(0);
    }

    return Buffer.from(waveform).toString("base64");
  } finally {
    // Clean up temp file
    try {
      await fs.unlink(tempPcm);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Generate a placeholder waveform (for when audio processing fails)
 */
function generatePlaceholderWaveform(): string {
  // Generate a simple sine-wave-like pattern
  const waveform: number[] = [];
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const value = Math.round(128 + 64 * Math.sin((i / WAVEFORM_SAMPLES) * Math.PI * 8));
    waveform.push(Math.min(255, Math.max(0, value)));
  }
  return Buffer.from(waveform).toString("base64");
}

/**
 * Convert audio file to OGG/Opus format if needed
 * Returns path to the OGG file (may be same as input if already OGG/Opus)
 */
export async function ensureOggOpus(filePath: string): Promise<{ path: string; cleanup: boolean }> {
  const ext = path.extname(filePath).toLowerCase();

  // Check if already OGG
  if (ext === ".ogg") {
    // Verify it's Opus codec, not Vorbis (Vorbis won't play on mobile)
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "csv=p=0",
        filePath,
      ]);
      if (stdout.trim().toLowerCase() === "opus") {
        return { path: filePath, cleanup: false };
      }
    } catch {
      // If probe fails, convert anyway
    }
  }

  // Convert to OGG/Opus
  const tempDir = os.tmpdir();
  const outputPath = path.join(tempDir, `voice-${Date.now()}.ogg`);

  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    filePath,
    "-c:a",
    "libopus",
    "-b:a",
    "64k",
    outputPath,
  ]);

  return { path: outputPath, cleanup: true };
}

/**
 * Get voice message metadata (duration and waveform)
 */
export async function getVoiceMessageMetadata(filePath: string): Promise<VoiceMessageMetadata> {
  const [durationSecs, waveform] = await Promise.all([
    getAudioDuration(filePath),
    generateWaveform(filePath),
  ]);

  return { durationSecs, waveform };
}

type UploadUrlResponse = {
  attachments: Array<{
    id: number;
    upload_url: string;
    upload_filename: string;
  }>;
};

/**
 * Send a voice message to Discord
 *
 * This follows Discord's voice message protocol:
 * 1. Request upload URL from Discord
 * 2. Upload the OGG file to the provided URL
 * 3. Send the message with flag 8192 and attachment metadata
 */
export async function sendDiscordVoiceMessage(
  rest: RequestClient,
  channelId: string,
  audioBuffer: Buffer,
  metadata: VoiceMessageMetadata,
  replyTo: string | undefined,
  request: RetryRunner,
  token: string,
): Promise<{ id: string; channel_id: string }> {
  const filename = "voice-message.ogg";
  const fileSize = audioBuffer.byteLength;

  // Step 1: Request upload URL (using fetch directly for proper headers)
  const uploadUrlRes = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({
        files: [
          {
            filename,
            file_size: fileSize,
            id: "0",
          },
        ],
      }),
    },
  );

  if (!uploadUrlRes.ok) {
    const errorBody = await uploadUrlRes.text();
    throw new Error(`Failed to get upload URL: ${uploadUrlRes.status} ${errorBody}`);
  }

  const uploadUrlResponse = (await uploadUrlRes.json()) as UploadUrlResponse;

  if (!uploadUrlResponse.attachments?.[0]) {
    throw new Error("Failed to get upload URL for voice message");
  }

  const { upload_url, upload_filename } = uploadUrlResponse.attachments[0];

  // Step 2: Upload the file to Discord's CDN
  const uploadResponse = await fetch(upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": "audio/ogg",
    },
    body: new Uint8Array(audioBuffer),
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload voice message: ${uploadResponse.status}`);
  }

  // Step 3: Send the message with voice message flag and metadata
  const messagePayload: {
    flags: number;
    attachments: Array<{
      id: string;
      filename: string;
      uploaded_filename: string;
      duration_secs: number;
      waveform: string;
    }>;
    message_reference?: { message_id: string; fail_if_not_exists: boolean };
  } = {
    flags: DISCORD_VOICE_MESSAGE_FLAG,
    attachments: [
      {
        id: "0",
        filename,
        uploaded_filename: upload_filename,
        duration_secs: metadata.durationSecs,
        waveform: metadata.waveform,
      },
    ],
  };

  // Note: Voice messages cannot have content, but can have message_reference for replies
  if (replyTo) {
    messagePayload.message_reference = {
      message_id: replyTo,
      fail_if_not_exists: false,
    };
  }

  const res = (await request(
    () =>
      rest.post(`/channels/${channelId}/messages`, {
        body: messagePayload,
      }) as Promise<{ id: string; channel_id: string }>,
    "voice-message",
  )) as { id: string; channel_id: string };

  return res;
}
