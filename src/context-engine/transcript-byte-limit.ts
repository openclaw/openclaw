import { parseNonNegativeByteSize } from "../config/byte-size.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveMaxActiveTranscriptBytes(cfg?: OpenClawConfig): number | undefined {
  const parsed = parseNonNegativeByteSize(
    cfg?.agents?.defaults?.compaction?.maxActiveTranscriptBytes,
  );
  return typeof parsed === "number" && parsed > 0 ? parsed : undefined;
}

/** A failed/no-progress byte attempt rearms only after another threshold of growth. */
export function refreshTranscriptByteCompactionLatch(
  latch: InternalSessionEntry["transcriptByteCompactionLatch"],
  sessionId: string,
  maxBytes: number | undefined,
  activeBytes: number | undefined,
): InternalSessionEntry["transcriptByteCompactionLatch"] {
  if (
    !latch ||
    maxBytes === undefined ||
    latch.sessionId !== sessionId ||
    latch.maxBytes !== maxBytes
  ) {
    return undefined;
  }
  if (activeBytes === undefined) {
    return latch;
  }
  if (activeBytes < maxBytes || activeBytes - latch.activeBytes >= maxBytes) {
    return undefined;
  }
  return activeBytes < latch.activeBytes ? { ...latch, activeBytes } : latch;
}
