// Shared warnings for compaction settings that validate but cannot affect runtime behavior.
import { parseNonNegativeByteSize } from "./byte-size.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_CHECK_ID =
  "core/doctor/active-transcript-byte-guard";
export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_PATH =
  "agents.defaults.compaction.maxActiveTranscriptBytes";
export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_REQUIREMENT =
  "requires-truncate-after-compaction";
export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_FIX_HINT =
  "Set agents.defaults.compaction.truncateAfterCompaction to true, or unset agents.defaults.compaction.maxActiveTranscriptBytes / set it to 0.";

function formatInactiveByteGuardMessage(value: number | string): string {
  return `maxActiveTranscriptBytes is set to ${String(
    value,
  )}, but the active-transcript byte guard is inactive because agents.defaults.compaction.truncateAfterCompaction is not true. Enable truncateAfterCompaction to rotate compacted transcripts, or unset maxActiveTranscriptBytes / set it to 0.`;
}

/** Collect non-fatal warnings for compaction settings that are accepted but inactive. */
export function collectInactiveActiveTranscriptByteGuardWarnings(
  cfg: OpenClawConfig,
): ConfigValidationIssue[] {
  const compaction = cfg.agents?.defaults?.compaction;
  if (!compaction || compaction.truncateAfterCompaction === true) {
    return [];
  }
  const maxActiveTranscriptBytes = compaction.maxActiveTranscriptBytes;
  const parsed = parseNonNegativeByteSize(maxActiveTranscriptBytes);
  if (typeof parsed !== "number" || parsed <= 0) {
    return [];
  }
  return [
    {
      path: INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_PATH,
      message: formatInactiveByteGuardMessage(maxActiveTranscriptBytes ?? parsed),
    },
  ];
}
