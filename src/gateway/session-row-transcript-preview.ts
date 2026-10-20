import { parseDateFirstTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionRow } from "../../packages/gateway-protocol/src/index.js";
import {
  isSessionTranscriptTerminalModel,
  readSessionTranscriptTerminalModel,
  type SessionTranscriptTerminalModel,
} from "../sessions/transcript-terminal-model.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";

export const SESSION_ROW_TRANSCRIPT_PREVIEW_MAX_BYTES = 64 * 1024;
export const SESSION_ROW_TRANSCRIPT_TERMINAL_MAX_BYTES = 256 * 1024;

export type SessionRowAssistantMessage = NonNullable<SessionRow["lastAssistantMessage"]>;
/** Null is known empty; unknown needs a bounded transcript backfill. */
export type SessionRowAssistantMessageFact = SessionRowAssistantMessage | null | "unknown";
/** An append can preserve the resident owner's fact without reading the transcript. */
export type SessionRowAssistantMessageUpdate = SessionRowAssistantMessageFact | "unchanged";

export function isSessionRowAssistantMessage(value: unknown): value is SessionRowAssistantMessage {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp)
  );
}

/** Message time orders agents' replies independently of later user or metadata activity. */
export function projectSessionRowAssistantMessage(
  event: unknown,
  text: string,
): SessionRowAssistantMessage | null {
  if (!isRecord(event) || !isRecord(event.message)) {
    return null;
  }
  const timestamp =
    parseDateFirstTimestampMs(event.message.timestamp) ??
    parseDateFirstTimestampMs(event.timestamp);
  return timestamp === undefined
    ? null
    : { text: Buffer.from(text, "utf16le").toString("utf16le"), timestamp };
}

export type SessionRowTranscriptProjection = {
  lastMessagePreview: string | null;
  lastAssistantMessage: SessionRowAssistantMessageUpdate;
  terminalModel: SessionTranscriptTerminalModel | null;
  indexedSeq: number | null;
};

/** Undefined needs a bounded tail lookup; a complete projection can include empty fields. */
export function projectSessionRowTranscriptFields(
  event: unknown,
  serializedBytes: number,
  indexedSeq: number,
  previousAssistantMessage: SessionRowAssistantMessageUpdate,
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
    lastAssistantMessage: !projected
      ? null
      : projected.role === "assistant"
        ? projectSessionRowAssistantMessage(event, projected.text)
        : previousAssistantMessage,
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
}):
  | (Omit<SessionRowTranscriptProjection, "lastAssistantMessage"> & {
      lastAssistantMessage: SessionRowAssistantMessageFact;
    })
  | undefined {
  if (!params.json || params.updatedAt !== params.transcriptUpdatedAt) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(params.json);
    return isRecord(value) &&
      (value.lastMessagePreview === null || typeof value.lastMessagePreview === "string") &&
      (value.lastAssistantMessage === undefined ||
        value.lastAssistantMessage === "unknown" ||
        value.lastAssistantMessage === "unchanged" ||
        value.lastAssistantMessage === null ||
        isSessionRowAssistantMessage(value.lastAssistantMessage)) &&
      (value.terminalModel === null || isSessionTranscriptTerminalModel(value.terminalModel)) &&
      value.indexedSeq === (params.indexedSeq ?? null)
      ? {
          lastMessagePreview: value.lastMessagePreview,
          // A persisted append directive has no resident predecessor after a cold load.
          lastAssistantMessage:
            value.lastAssistantMessage === undefined || value.lastAssistantMessage === "unchanged"
              ? "unknown"
              : value.lastAssistantMessage,
          terminalModel: value.terminalModel,
          indexedSeq: params.indexedSeq ?? null,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
