// Reports compaction byte guards that are configured but cannot run.
import { parseNonNegativeByteSize } from "./byte-size.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_CHECK_ID = "core/doctor/compaction-byte-guard";
export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_PATH =
  "agents.defaults.compaction.maxActiveTranscriptBytes";

export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_MESSAGE =
  "maxActiveTranscriptBytes is set, but truncateAfterCompaction is not true; the active transcript byte guard is inactive.";

export const INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_FIX_HINT =
  "Enable agents.defaults.compaction.truncateAfterCompaction or unset agents.defaults.compaction.maxActiveTranscriptBytes.";

export function collectInactiveMaxActiveTranscriptBytesWarnings(
  cfg: OpenClawConfig,
): ConfigValidationIssue[] {
  const compaction = cfg.agents?.defaults?.compaction;
  const maxActiveTranscriptBytes = parseNonNegativeByteSize(compaction?.maxActiveTranscriptBytes);
  if (
    typeof maxActiveTranscriptBytes !== "number" ||
    maxActiveTranscriptBytes <= 0 ||
    compaction?.truncateAfterCompaction === true
  ) {
    return [];
  }

  return [
    {
      path: INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_PATH,
      message: INACTIVE_MAX_ACTIVE_TRANSCRIPT_BYTES_MESSAGE,
    },
  ];
}
