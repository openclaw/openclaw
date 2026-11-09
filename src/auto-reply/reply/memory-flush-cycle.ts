// Memory-flush cycle rules: thresholds, and the byte window for CLI backends that own compaction.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { MEMORY_FLUSH_ALLOWED_TOOLS } from "../../agents/agent-tools.memory-flush.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  isToolsMemoryFlushPlan,
  type MemoryFlushPlanForRunResolution,
} from "./memory-flush-plan.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveCompactionThreshold,
} from "./memory-flush.js";

type MemoryFlushPlan = MemoryFlushPlanForRunResolution["plan"];

/**
 * Transcript growth that re-arms a memory flush on CLI backends.
 *
 * Those backends own compaction natively, so `SessionEntry.compactionCount`
 * never advances for them: the compaction-cycle watermark can never clear, and
 * a single flush would disable the feature for the rest of the session.
 * Transcript bytes advance on every backend, so they anchor the dedup instead.
 */
export const CLI_MEMORY_FLUSH_REARM_BYTES = 256 * 1024;

/**
 * Bucket a CLI session's transcript size into re-arm windows, or `undefined`
 * when the session cannot use the byte anchor (not a CLI backend, or no
 * transcript size available) and must keep the compaction-cycle watermark.
 */
export function resolveCliMemoryFlushRearmBucket(params: {
  isCli: boolean;
  transcriptByteSize?: number;
  rearmBytes?: number;
}): number | undefined {
  if (!params.isCli) {
    return undefined;
  }
  const { transcriptByteSize } = params;
  if (typeof transcriptByteSize !== "number" || !Number.isFinite(transcriptByteSize)) {
    return undefined;
  }
  const rearmBytes = params.rearmBytes ?? CLI_MEMORY_FLUSH_REARM_BYTES;
  if (!Number.isFinite(rearmBytes) || rearmBytes <= 0) {
    return undefined;
  }
  return Math.floor(Math.max(0, transcriptByteSize) / rearmBytes);
}

/**
 * True when this CLI session already completed its flush for the current byte
 * bucket. Only a `succeeded` record suppresses; a `failed` record carries the
 * bucket for attribution while the retry lifecycle still owns it.
 */
export function hasAlreadyFlushedForCliRearmBucket(
  entry: Pick<SessionEntry, "memoryFlush"> | undefined,
  bucket: number,
): boolean {
  const memoryFlush = entry?.memoryFlush;
  return memoryFlush?.kind === "succeeded" && memoryFlush.cliRearmBucket === bucket;
}

/** The soft margin belongs only to early flushing, leaving room before blocking compaction. */
export function threshold(
  contextWindowTokens: number,
  plan: Pick<MemoryFlushPlan, "reserveTokensFloor" | "softThresholdTokens">,
): number {
  const compactionThreshold = resolveCompactionThreshold({
    contextWindowTokens,
    reserveTokensFloor: plan.reserveTokensFloor,
  });
  return Math.max(0, compactionThreshold - Math.max(0, Math.floor(plan.softThresholdTokens)));
}

/**
 * Whether a flush is already settled before the transcript is read. CLI sessions
 * dedup on the byte window instead of the compaction-cycle watermark, and
 * provider-owned tool plans have no single append-only target to bound a CLI
 * loopback grant with.
 */
export function isSettled(
  isCli: boolean,
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlush">,
  plan: MemoryFlushPlan,
): boolean {
  return isCli ? isToolsMemoryFlushPlan(plan) : hasAlreadyFlushedForCurrentCompaction(entry);
}

/**
 * Resolve the transcript-size trigger and, for CLI sessions, the byte re-arm
 * window that replaces the compaction-cycle watermark. A CLI session without a
 * size would flush once and then never again, so it keeps the skip instead.
 */
export function byteTrigger(params: {
  isCli: boolean;
  entry: Pick<SessionEntry, "memoryFlush">;
  sessionLogSnapshot: { byteSize?: number };
  memoryFlushPlan: Pick<MemoryFlushPlan, "forceFlushTranscriptBytes">;
}): { skip: boolean; forced: boolean; cliRearmBucket?: number } {
  const transcriptByteSize = params.sessionLogSnapshot.byteSize;
  const { forceFlushTranscriptBytes } = params.memoryFlushPlan;
  // CLI sessions read the size even when byte forcing is off, so a zero
  // threshold must stay disabled rather than match every transcript.
  const forced =
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0 &&
    transcriptByteSize !== undefined &&
    transcriptByteSize >= forceFlushTranscriptBytes;
  if (!params.isCli) {
    return { skip: false, forced };
  }
  const cliRearmBucket = resolveCliMemoryFlushRearmBucket({ isCli: true, transcriptByteSize });
  const skip =
    cliRearmBucket === undefined ||
    hasAlreadyFlushedForCliRearmBucket(params.entry, cliRearmBucket);
  return { skip, forced, cliRearmBucket };
}

/**
 * Run a CLI session's flush on the runtime it was configured for. Without the
 * opt-in an embedded flush targeting a CLI runtime falls through to the
 * direct-API passthrough; the named allowlist bounds the loopback grant to the
 * read/append-only pair agent-tools constructs for a flush.
 */
export function cliDispatch(isCli: boolean) {
  return isCli
    ? {
        cliBackendDispatch: "subscription-auth" as const,
        toolsAllow: [...MEMORY_FLUSH_ALLOWED_TOOLS],
      }
    : {};
}

/** Success record; CLI sessions also record the byte window they flushed for. */
export function succeeded(
  compactionCount: number,
  cliRearmBucket: number | undefined,
): NonNullable<SessionEntry["memoryFlush"]> {
  return {
    kind: "succeeded",
    compactionCount,
    ...(cliRearmBucket !== undefined ? { cliRearmBucket } : {}),
  };
}

/**
 * Run the caller's pre-compaction memory hook for a CLI session that keeps
 * native compaction. Reply and command turns reach the flush only through this
 * hook, and the flush applies its own trigger and byte-window dedup.
 */
export async function beforeNativeCompaction<Entry>(
  isCli: boolean,
  runtimeId: string,
  entry: Entry,
  params: { beforeCompaction?: (entry: Entry) => Promise<Entry | undefined> },
): Promise<Entry> {
  if (!isCli || normalizeLowercaseStringOrEmpty(runtimeId) === "codex") {
    return entry;
  }
  return (await params.beforeCompaction?.(entry)) ?? entry;
}
