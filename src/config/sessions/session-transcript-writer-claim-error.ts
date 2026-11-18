import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type TranscriptAppendRefusal =
  | {
      actualSessionIdHash: string;
      agentIdHash: string;
      code: "session-rebound";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    }
  | {
      agentIdHash: string;
      code: "session-entry-missing";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    };

function isRedactedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^(?:-|sha256:[0-9a-f]{12})$/.test(value);
}

/** Transport only the refusal owner's redacted identifiers, never incidental cause fields. */
export function parseTranscriptAppendRefusal(value: unknown): TranscriptAppendRefusal | undefined {
  if (
    !isRecord(value) ||
    !isRedactedIdentifier(value.agentIdHash) ||
    !isRedactedIdentifier(value.expectedSessionIdHash) ||
    !isRedactedIdentifier(value.sessionKeyHash)
  ) {
    return undefined;
  }
  const identity = {
    agentIdHash: value.agentIdHash,
    expectedSessionIdHash: value.expectedSessionIdHash,
    sessionKeyHash: value.sessionKeyHash,
  };
  if (value.code === "session-entry-missing") {
    return { ...identity, code: value.code };
  }
  if (value.code === "session-rebound" && isRedactedIdentifier(value.actualSessionIdHash)) {
    return { ...identity, code: value.code, actualSessionIdHash: value.actualSessionIdHash };
  }
  return undefined;
}

export class SessionTranscriptWriterClaimReboundError extends Error {
  constructor(cause?: TranscriptAppendRefusal) {
    super("session writer claim changed before transcript persistence", { cause });
    this.name = "SessionTranscriptWriterClaimReboundError";
  }
}
