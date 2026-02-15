import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import { runExec } from "../../../process/exec.js";
import { fetchWithTimeoutGuarded, normalizeBaseUrl, readErrorResponse } from "../shared.js";

export const DEFAULT_OPENAI_AUDIO_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_AUDIO_MODEL = "gpt-4o-mini-transcribe";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_OPENAI_AUDIO_MODEL;
}

function shouldUseGroqCurlFallback(
  params: AudioTranscriptionRequest,
  status: number,
  url: string,
): boolean {
  if (typeof params.fetchFn === "function") {
    return false;
  }
  if (status !== 403) {
    return false;
  }
  return url.startsWith("https://api.groq.com/");
}

function parseJsonTextPayload(raw: string): string {
  const payload = JSON.parse(raw) as { text?: string };
  const text = payload.text?.trim();
  if (!text) {
    throw new Error("Audio transcription response missing text");
  }
  return text;
}

async function transcribeWithCurlFallback(params: {
  url: string;
  apiKey: string;
  buffer: Buffer;
  fileName: string;
  mime?: string;
  model: string;
  language?: string;
  prompt?: string;
  timeoutMs: number;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-curl-"));
  const audioPath = path.join(tempDir, "audio.bin");
  const outputPath = path.join(tempDir, "out.json");
  const curlConfigPath = path.join(tempDir, "curl.conf");

  const escapedFileName = params.fileName.replace(/"/g, '\\"');
  const escapedMime = (params.mime ?? "application/octet-stream").replace(/"/g, '\\"');
  const configLines = [
    "silent",
    "show-error",
    "fail-with-body",
    'request = "POST"',
    `url = "${params.url}"`,
    `header = "Authorization: Bearer ${params.apiKey}"`,
    `form = "file=@${audioPath};filename=${escapedFileName};type=${escapedMime}"`,
    `form = "model=${params.model}"`,
    `output = "${outputPath}"`,
  ];

  if (params.language?.trim()) {
    configLines.push(`form = "language=${params.language.trim()}"`);
  }
  if (params.prompt?.trim()) {
    const escapedPrompt = params.prompt.trim().replace(/"/g, '\\"');
    configLines.push(`form = "prompt=${escapedPrompt}"`);
  }

  try {
    await fs.writeFile(audioPath, params.buffer);
    await fs.writeFile(curlConfigPath, `${configLines.join("\n")}\n`, "utf8");
    await runExec("curl", ["--config", curlConfigPath], {
      timeoutMs: params.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const raw = await fs.readFile(outputPath, "utf8");
    return parseJsonTextPayload(raw);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function transcribeOpenAiCompatibleAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_OPENAI_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model);
  const form = new FormData();
  const fileName = params.fileName?.trim() || path.basename(params.fileName) || "audio";
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], {
    type: params.mime ?? "application/octet-stream",
  });
  form.append("file", blob, fileName);
  form.append("model", model);
  if (params.language?.trim()) {
    form.append("language", params.language.trim());
  }
  if (params.prompt?.trim()) {
    form.append("prompt", params.prompt.trim());
  }

  const headers = new Headers(params.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${params.apiKey}`);
  }

  const { response: res, release } = await fetchWithTimeoutGuarded(
    url,
    {
      method: "POST",
      headers,
      body: form,
    },
    params.timeoutMs,
    fetchFn,
    allowPrivate ? { ssrfPolicy: { allowPrivateNetwork: true } } : undefined,
  );

  try {
    if (!res.ok) {
      if (shouldUseGroqCurlFallback(params, res.status, url)) {
        const fallbackText = await transcribeWithCurlFallback({
          url,
          apiKey: params.apiKey,
          buffer: params.buffer,
          fileName,
          mime: params.mime,
          model,
          language: params.language,
          prompt: params.prompt,
          timeoutMs: params.timeoutMs,
        });
        return { text: fallbackText, model };
      }
      const detail = await readErrorResponse(res);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Audio transcription failed (HTTP ${res.status})${suffix}`);
    }

    const raw = await res.text();
    const text = parseJsonTextPayload(raw);
    return { text, model };
  } finally {
    await release();
  }
}
