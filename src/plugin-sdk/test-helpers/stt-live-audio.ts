import { expect } from "vitest";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
} from "../realtime-transcription.js";

export function normalizeTranscriptForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export const OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE = /open(?:claw|cl|flaw|clar|core)/;

export function expectOpenClawLiveTranscriptMarker(value: string): void {
  expect(normalizeTranscriptForMatch(value)).toMatch(OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForLiveExpectation(expectation: () => void, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

export async function synthesizeElevenLabsLiveSpeech(params: {
  text: string;
  apiKey: string;
  outputFormat: "mp3_44100_128" | "ulaw_8000";
  timeoutMs?: number;
}): Promise<Buffer> {
  const baseUrl = process.env.ELEVENLABS_BASE_URL?.trim() || "https://api.elevenlabs.io";
  const voiceId = process.env.ELEVENLABS_LIVE_VOICE_ID?.trim() || "pMsXgVXv3BLzUgSXRplE";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000);
  try {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1/text-to-speech/${voiceId}`);
    url.searchParams.set("output_format", params.outputFormat);
    const response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": params.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
          speed: 1,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Release the connection without buffering an unbounded error payload.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`ElevenLabs live TTS failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

type AudioInput = { audio: Buffer; chunkSize?: number; delayMs?: number };

export async function streamAudioForLiveTest(
  params: AudioInput & { sendAudio: (chunk: Buffer) => void },
) {
  const chunkSize = params.chunkSize ?? 160;
  const delayMs = params.delayMs ?? 5;
  for (let offset = 0; offset < params.audio.byteLength; offset += chunkSize) {
    params.sendAudio(params.audio.subarray(offset, offset + chunkSize));
    await delay(delayMs);
  }
}

export async function runRealtimeSttLiveTest(
  params: AudioInput & {
    provider: RealtimeTranscriptionProviderPlugin;
    providerConfig: RealtimeTranscriptionProviderConfig;
    expectedNormalizedText?: RegExp | string;
    timeoutMs?: number;
    closeBeforeWait?: boolean;
  },
): Promise<{ transcripts: string[]; partials: string[]; errors: Error[] }> {
  const transcripts: string[] = [];
  const partials: string[] = [];
  const errors: Error[] = [];
  const expected = params.expectedNormalizedText ?? OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE;
  const session = params.provider.createSession({
    providerConfig: params.providerConfig,
    onPartial: (partial) => partials.push(partial),
    onTranscript: (transcript) => transcripts.push(transcript),
    onError: (error) => errors.push(error),
  });

  try {
    await session.connect();
    await streamAudioForLiveTest({ ...params, sendAudio: (chunk) => session.sendAudio(chunk) });
    if (params.closeBeforeWait) {
      session.close();
    }

    await waitForLiveExpectation(() => {
      if (errors[0]) {
        throw errors[0];
      }
      expect(normalizeTranscriptForMatch(transcripts.join(" "))).toMatch(expected);
    }, params.timeoutMs ?? 60_000);
  } finally {
    session.close();
  }

  expect(partials.length + transcripts.length).toBeGreaterThan(0);
  return { transcripts, partials, errors };
}
