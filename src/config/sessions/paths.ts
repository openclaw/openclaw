import { isCompactionCheckpointTranscriptFileName } from "./artifacts.js";

export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (
    !SAFE_SESSION_ID_RE.test(trimmed) ||
    isCompactionCheckpointTranscriptFileName(`${trimmed}.jsonl`)
  ) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}
