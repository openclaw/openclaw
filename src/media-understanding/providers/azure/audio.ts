import path from "node:path";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAzureFoundryApiVersionEnv } from "../../../providers/azure-foundry/env.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "../../types.js";
import {
  assertOkOrThrowHttpError,
  normalizeBaseUrl,
  postTranscriptionRequest,
  requireTranscriptionText,
} from "../shared.js";

const log = createSubsystemLogger("azure-audio");

const DEFAULT_AZURE_AUDIO_BASE_URL = "https://models.inference.ai.azure.com";
const DEFAULT_AZURE_AUDIO_MODEL = "whisper-large-v3-turbo";
const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview";

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_AZURE_AUDIO_MODEL;
}

/**
 * Build the transcription URL for Azure Foundry.
 *
 * Two forms are supported:
 *
 * 1. **Full deployment URL** (baseUrl already contains `/openai/deployments/{name}`):
 *    → append `/audio/transcriptions`
 *
 * 2. **Bare endpoint** (e.g. `https://models.inference.ai.azure.com`):
 *    → append `/openai/deployments/{model}/audio/transcriptions`
 */
function buildTranscriptionUrl(baseUrl: string, model: string): URL {
  if (/\/openai\/deployments\/[^/]+\/?$/i.test(baseUrl)) {
    // baseUrl already points to a specific deployment.
    return new URL(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`);
  }
  return new URL(`${baseUrl}/openai/deployments/${encodeURIComponent(model)}/audio/transcriptions`);
}

export async function transcribeAzureAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const baseUrl = normalizeBaseUrl(params.baseUrl, DEFAULT_AZURE_AUDIO_BASE_URL);
  const allowPrivate = Boolean(params.baseUrl?.trim());

  const model = resolveModel(params.model);
  const url = buildTranscriptionUrl(baseUrl, model);

  // Apply query params from providerOptions (e.g. api-version).
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  // Ensure api-version is always present.
  if (!url.searchParams.has("api-version")) {
    const apiVersion =
      resolveAzureFoundryApiVersionEnv(process.env)?.value || DEFAULT_AZURE_API_VERSION;
    url.searchParams.set("api-version", apiVersion);
  }

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
  // Remove any Bearer auth that may have been set by the caller.
  headers.delete("authorization");
  // Azure OpenAI transcription endpoints accept api-key (and optional Bearer token),
  // including cognitiveservices and services.ai hosts.
  headers.set("api-key", params.apiKey);

  const { response: res, release } = await postTranscriptionRequest({
    url: url.toString(),
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork: allowPrivate,
  });

  try {
    await assertOkOrThrowHttpError(res, "Azure audio transcription failed");

    const payload = (await res.json()) as { text?: string };
    const text = requireTranscriptionText(
      payload.text,
      "Azure audio transcription response missing text",
    );
    return { text, model };
  } catch (err) {
    log.warn(`Transcription failed for ${url.origin}${url.pathname}: ${String(err)}`);
    throw err;
  } finally {
    await release();
  }
}
