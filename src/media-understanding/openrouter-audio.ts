import path from "node:path";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { AudioTranscriptionRequest } from "./types.js";

const SUPPORTED_AUDIO_FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
const AUDIO_FORMAT_BY_MIME = new Map([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/flac", "flac"],
  ["audio/mp4", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/ogg", "ogg"],
  ["audio/oga", "ogg"],
  ["audio/opus", "ogg"],
  ["audio/webm", "webm"],
  ["audio/aac", "aac"],
]);

/** Native JSON audio payload shared by direct and catalog-scoped OpenRouter consumers. */
export function buildOpenRouterAudioTranscriptionBody(
  params: Pick<AudioTranscriptionRequest, "buffer" | "fileName" | "mime" | "language" | "query"> & {
    model: string;
  },
) {
  let format = AUDIO_FORMAT_BY_MIME.get(normalizeMimeType(params.mime) ?? "");
  if (format === undefined) {
    const ext = path
      .extname(params.fileName ?? "")
      .trim()
      .toLowerCase()
      .replace(/^\./, "");
    if (ext === "mpeg") {
      format = "mp3";
    } else if (ext === "mp4") {
      format = "m4a";
    } else if (ext === "oga" || ext === "opus") {
      format = "ogg";
    } else {
      format = SUPPORTED_AUDIO_FORMATS.has(ext) ? ext : undefined;
    }
  }
  if (!format) {
    throw new Error(
      `OpenRouter STT could not resolve audio format from mime "${params.mime ?? ""}" and file "${params.fileName ?? ""}"`,
    );
  }
  const temperature = asFiniteNumber(params.query?.temperature);
  return {
    model: params.model,
    input_audio: { data: params.buffer.toString("base64"), format },
    ...(params.language?.trim() ? { language: params.language.trim() } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}
