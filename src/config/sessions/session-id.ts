export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const RESERVED_COMPACTION_CHECKPOINT_SESSION_ID_RE =
  /^.+\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (
    !SAFE_SESSION_ID_RE.test(trimmed) ||
    RESERVED_COMPACTION_CHECKPOINT_SESSION_ID_RE.test(trimmed)
  ) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}
