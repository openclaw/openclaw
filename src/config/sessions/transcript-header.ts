// Transcript headers record session identity and version as the first entry.
import { randomUUID } from "node:crypto";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CURRENT_SESSION_VERSION } from "./version.js";

/** Inputs for the first entry in a session transcript. */
type SessionTranscriptHeaderParams = {
  sessionId?: string;
  /** Copied history retains its original model projection policy. */
  version?: number;
  cwd?: string;
  /** Source transcript lineage recorded on forked transcript headers. */
  parentSession?: string;
  /** Stable timestamp shared with sibling records written in the same operation. */
  timestamp?: string;
};

/** Creates a session transcript header entry with current version metadata. */
export function createSessionTranscriptHeader(params: SessionTranscriptHeaderParams = {}) {
  return {
    type: "session",
    version: params.version ?? CURRENT_SESSION_VERSION,
    id: params.sessionId ?? randomUUID(),
    timestamp: params.timestamp ?? new Date().toISOString(),
    cwd: params.cwd ?? process.cwd(),
    ...(params.parentSession ? { parentSession: params.parentSession } : {}),
  };
}

/** Retained header fallback for the session's creation boundary. */
export function readSessionTranscriptHeaderStartedAt(
  value: unknown,
  sessionId: string,
): number | undefined {
  const header = asOptionalRecord(value);
  if (
    header?.type !== "session" ||
    (typeof header.id === "string" && header.id.trim() && header.id !== sessionId)
  ) {
    return undefined;
  }
  const timestamp = header.timestamp;
  const parsed =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string" && timestamp.trim()
        ? Date.parse(timestamp)
        : undefined;
  const timestampMs = asDateTimestampMs(parsed);
  return timestampMs !== undefined && timestampMs >= 0 ? timestampMs : undefined;
}

/** Session-row fields that record where a session actually runs. */
type ResetHeaderCwdSource = {
  spawnedCwd?: string;
  spawnedWorkspaceDir?: string;
};

/** The prior transcript owns its workspace; caller context covers an unset row. */
export function resolveResetBoundaryHeaderCwd(
  priorEntry: ResetHeaderCwdSource,
  fallbackCwd: string,
): string {
  return priorEntry.spawnedCwd ?? priorEntry.spawnedWorkspaceDir ?? fallbackCwd;
}
