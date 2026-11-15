import type { TranscriptUtterance } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import type { TranscriptExportRead, TranscriptLibraryError } from "./store-read.js";

export type TranscriptExportCommand = {
  type: "meetingTranscripts.export";
} & (
  | { format: "library"; selector: string; includeNotes: boolean }
  | {
      format: "artifact";
      session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
    }
);

export type TranscriptExportChunk =
  | { format: "library"; utterances: TranscriptUtterance[] }
  | { format: "artifact"; jsonl: string };

export type TranscriptExportResult =
  | { ok: true; read?: TranscriptExportRead }
  | { ok: false; error: Pick<TranscriptLibraryError, "type" | "message" | "maxBytes"> };
