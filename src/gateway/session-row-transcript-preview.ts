import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSessionTranscriptTerminalModel,
  readSessionTranscriptTerminalModel,
  type SessionTranscriptTerminalModel,
} from "../sessions/transcript-terminal-model.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

export const SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES = 64 * 1024;
export const SESSION_ROW_TRANSCRIPT_TERMINAL_MAX_BYTES = 256 * 1024;

export type SessionRowTranscriptProjection = {
  lastMessagePreview: string | null;
  terminalModel: SessionTranscriptTerminalModel | null;
  indexedSeq: number | null;
};

/** Undefined needs a bounded tail lookup; a complete projection can include empty fields. */
export function projectSessionRowTranscriptFields(
  event: unknown,
  serializedBytes: number,
  indexedSeq: number,
): SessionRowTranscriptProjection | undefined {
  if (!isRecord(event) || event.type === "session" || !event.message) {
    return undefined;
  }
  const projected =
    serializedBytes <= SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES
      ? projectSessionDisplayMessage(event.message, { flattenMarkdown: true })
      : null;
  if (!projected && serializedBytes <= SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES) {
    return undefined;
  }
  return {
    lastMessagePreview: projected
      ? Buffer.from(projected.text, "utf16le").toString("utf16le")
      : null,
    terminalModel:
      serializedBytes <= SESSION_ROW_TRANSCRIPT_TERMINAL_MAX_BYTES
        ? readSessionTranscriptTerminalModel(event)
        : null,
    indexedSeq,
  };
}

/** Older imports may preserve mtime while appending; their index still advances. */
export function readStoredSessionRowTranscriptProjection(params: {
  json: string | null | undefined;
  updatedAt: number | null | undefined;
  transcriptUpdatedAt: number | null | undefined;
  indexedSeq: number | null | undefined;
}): SessionRowTranscriptProjection | undefined {
  if (!params.json || params.updatedAt !== params.transcriptUpdatedAt) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(params.json);
    return isRecord(value) &&
      (value.lastMessagePreview === null || typeof value.lastMessagePreview === "string") &&
      (value.terminalModel === null || isSessionTranscriptTerminalModel(value.terminalModel)) &&
      value.indexedSeq === (params.indexedSeq ?? null)
      ? {
          lastMessagePreview: value.lastMessagePreview,
          terminalModel: value.terminalModel,
          indexedSeq: params.indexedSeq ?? null,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
