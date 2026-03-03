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

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RequestClient } from "@buape/carbon";
import type { RetryRunner } from "../infra/retry-policy.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { parseFfprobeCodecAndSampleRate, runFfmpeg, runFfprobe } from "../media/ffmpeg-exec.js";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "../media/ffmpeg-limits.js";
import { unlinkIfExists } from "../media/temp-files.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
const WAVEFORM_SAMPLES = 256;
const DISCORD_OPUS_SAMPLE_RATE_HZ = 48_000;

export type VoiceMessageMetadata = {
  durationSecs: number;
  waveform: string; // base64 encoded
};

/**
 * Get audio duration using ffprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const stdout = await runFfprobe([
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
    const errMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get audio duration: ${errMessage}`, { cause: err });
  }
}

/**
 * Generate waveform data from audio file using ffmpeg
 * Returns base64 encoded byte array of amplitude samples (0-255)
 */
export async function generateWaveform(filePath: string): Promise<string> {
  try {
    // Extract raw PCM and sample amplitude values
    return await generateWaveformFromPcm(filePath);
  } catch {
    // If PCM extraction fails, generate a placeholder waveform
    return generatePlaceholderWaveform();
  }
}

/**
 * Generate waveform by extracting raw PCM data and sampling amplitudes
 */
async function generateWaveformFromPcm(filePath: string): Promise<string> {
  const tempDir = resolvePreferredOpenClawTmpDir();
  const tempPcm = path.join(tempDir, `waveform-${crypto.randomUUID()}.raw`);

  try {
    // Convert to raw 16-bit signed PCM, mono, 8kHz
    await runFfmpeg([
      "-y",
      "-i",
      filePath,
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
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
        sum += Math.abs(samples[i * step + j]);
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
    await unlinkIfExists(tempPcm);
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
  const trimmed = filePath.trim();
  // Defense-in-depth: callers should never hand ffmpeg/ffprobe a URL/protocol path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `Voice message conversion requires a local file path; received a URL/protocol source: ${trimmed}`,
    );
  }

  const ext = path.extname(filePath).toLowerCase();

  // Check if already OGG
  if (ext === ".ogg") {
    // Fast-path only when the file is Opus at Discord's expected 48kHz.
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
      if (codec === "opus" && sampleRateHz === DISCORD_OPUS_SAMPLE_RATE_HZ) {
        return { path: filePath, cleanup: false };
      }
    } catch {
      // If probe fails, convert anyway
    }
  }

  // Convert to OGG/Opus
  // Always resample to 48kHz to ensure Discord voice messages play at correct speed
  // (Discord expects 48kHz; lower sample rates like 24kHz from some TTS providers cause 0.5x playback)
  const tempDir = resolvePreferredOpenClawTmpDir();
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
    String(DISCORD_OPUS_SAMPLE_RATE_HZ),
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

function formatCauseMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  return String(err);
}

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
  silent?: boolean,
  token?: string,
): Promise<{ id: string; channel_id: string }> {
  const filename = "voice-message.ogg";
  const fileSize = audioBuffer.byteLength;

  const flags = silent
    ? DISCORD_VOICE_MESSAGE_FLAG | SUPPRESS_NOTIFICATIONS_FLAG
    : DISCORD_VOICE_MESSAGE_FLAG;

  const makePayload = (uploadedFilename: string) => {
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
      flags,
      attachments: [
        {
          id: "0",
          filename,
          uploaded_filename: uploadedFilename,
          duration_secs: metadata.durationSecs,
          waveform: metadata.waveform,
        },
      ],
    };

    if (replyTo) {
      messagePayload.message_reference = {
        message_id: replyTo,
        fail_if_not_exists: false,
      };
    }
    return messagePayload;
  };

  // Primary path via RequestClient
  let uploadUrlResponse: UploadUrlResponse;
  try {
    uploadUrlResponse = await request(
      () =>
        rest.post(`/channels/${channelId}/attachments`, {
          body: {
            files: [
              {
                filename,
                file_size: fileSize,
                id: "0",
              },
            ],
          },
        }) as Promise<UploadUrlResponse>,
      "voice-upload-url",
    );
  } catch (err) {
    if (!token) {
      throw err;
    }
    uploadUrlResponse = await requestVoiceUploadSlotFallback(
      channelId,
      fileSize,
      filename,
      token,
      err,
    );
  }

  if (!uploadUrlResponse.attachments?.[0]) {
    throw new Error("Failed to get upload URL for voice message");
  }

  const { upload_url, upload_filename } = uploadUrlResponse.attachments[0];

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

  try {
    return (await request(
      () =>
        rest.post(`/channels/${channelId}/messages`, {
          body: makePayload(upload_filename),
        }) as Promise<{ id: string; channel_id: string }>,
      "voice-message",
    )) as { id: string; channel_id: string };
  } catch (err) {
    if (!token) {
      throw err;
    }
    return await sendVoiceMessageFallback(channelId, makePayload(upload_filename), token, err);
  }
}

async function requestVoiceUploadSlotFallback(
  channelId: string,
  fileSize: number,
  filename: string,
  token: string,
  cause: unknown,
): Promise<UploadUrlResponse> {
  const authHeaders = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  const slotRes = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/attachments`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      files: [
        {
          id: "0",
          filename,
          file_size: fileSize,
        },
      ],
    }),
  });

  if (!slotRes.ok) {
    const txt = await slotRes.text().catch(() => "");
    throw new Error(
      `Discord voice upload slot failed (${slotRes.status})${txt ? `: ${txt}` : ""}; fallback after request-client slot error: ${formatCauseMessage(cause)}`,
      { cause },
    );
  }

  const slotPayload = (await slotRes.json()) as UploadUrlResponse;
  const slot = slotPayload.attachments?.[0];
  if (!slot?.upload_url || !slot?.upload_filename) {
    throw new Error("Discord voice upload slot payload missing upload_url/upload_filename", {
      cause,
    });
  }

  return slotPayload;
}

async function sendVoiceMessageFallback(
  channelId: string,
  payload: {
    flags: number;
    attachments: Array<{
      id: string;
      filename: string;
      uploaded_filename: string;
      duration_secs: number;
      waveform: string;
    }>;
    message_reference?: { message_id: string; fail_if_not_exists: boolean };
  },
  token: string,
  cause: unknown,
): Promise<{ id: string; channel_id: string }> {
  const authHeaders = {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  };

  const msgRes = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(payload),
  });

  if (!msgRes.ok) {
    const txt = await msgRes.text().catch(() => "");
    throw new Error(
      `Discord voice message failed (${msgRes.status})${txt ? `: ${txt}` : ""}; fallback after request-client message error: ${formatCauseMessage(cause)}`,
      { cause },
    );
  }

  return (await msgRes.json()) as { id: string; channel_id: string };
}
