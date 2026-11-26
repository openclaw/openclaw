import { classifyCompactionReason } from "../../agents/embedded-agent-runner/compact-reasons.js";
import { resolveCompactionTimeoutMs } from "../../agents/embedded-agent-runner/compaction-safety-timeout.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { MemoryFlushResult } from "./agent-runner-memory.types.js";
import { formatCompactionModelRef } from "./compaction-notice.js";

type PreflightStage = "memory flush" | "compaction";

/** A preflight maintenance model went quiet for the whole compaction progress window. */
export class PreflightStallError extends Error {
  override name = "PreflightStallError";

  constructor(
    readonly stage: PreflightStage,
    readonly modelRef: string,
    readonly windowMs: number,
  ) {
    // The prefix keeps the existing preflight failure handling (kept input, failure reply).
    super(
      `Preflight compaction required but failed: ${stage} timed out on ${modelRef} after ${Math.round(windowMs / 1000)}s without progress`,
    );
  }
}

/** A timed-out preflight compaction names the compaction model, else the reply's own model. */
export function createCompactionStall(
  reason: string,
  cfg: OpenClawConfig,
  run: { provider?: string; model?: string },
): PreflightStallError | undefined {
  if (classifyCompactionReason(reason) !== "timeout") {
    return undefined;
  }
  return new PreflightStallError(
    "compaction",
    cfg.agents?.defaults?.compaction?.model?.trim() ||
      formatCompactionModelRef(run.provider, run.model),
    resolveCompactionTimeoutMs(cfg),
  );
}

export function renderPreflightStallText(error: unknown): string | undefined {
  if (!(error instanceof PreflightStallError)) {
    return undefined;
  }
  const what = error.stage === "memory flush" ? "Memory maintenance" : "Compaction";
  return (
    `⚠️ ${what} before this reply stalled: ${error.modelRef} sent no output for ` +
    `${Math.round(error.windowMs / 1000)}s. Check that the model is running and responsive ` +
    "(for a slow local model, raise agents.defaults.compaction.timeoutSeconds), then try again."
  );
}

/**
 * Bounds a reply's private memory flush by the same progress window as compaction.
 * Output deltas reset it; expiry aborts the flush with a stall naming its model.
 */
export function startMemoryFlushStallGuard(
  { cfg, replyOperation }: { cfg: OpenClawConfig; replyOperation?: ReplyOperation },
  model: { provider?: string; model?: string },
  abortSignal: AbortSignal | undefined,
) {
  // Only a waiting reply needs its silent flush bounded; detached maintenance keeps its owner's limits.
  if (!replyOperation) {
    return undefined;
  }
  const windowMs = resolveCompactionTimeoutMs(cfg);
  const controller = new AbortController();
  let modelRef = formatCompactionModelRef(model.provider, model.model);
  let stall: PreflightStallError | undefined;
  const timer = setTimeout(() => {
    stall = new PreflightStallError("memory flush", modelRef, windowMs);
    controller.abort(stall);
  }, windowMs);
  timer.unref();
  return {
    signal: abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal,
    get stall() {
      return stall;
    },
    setModel(provider: string, modelId: string) {
      modelRef = formatCompactionModelRef(provider, modelId);
    },
    /** Content deltas from the live flush keep both the reply watchdog and this window alive. */
    progress(flushSignal: AbortSignal) {
      if (!flushSignal.aborted && !stall) {
        replyOperation.watchdog.progress("semantic", "memory_flush:model_output");
        timer.refresh();
      }
    },
    /** A stalled flush is a failed flush whose stall the waiting preflight reports. */
    failure(sessionEntry: SessionEntry | undefined): MemoryFlushResult | undefined {
      return stall && { sessionEntry, outcome: "failed", stall };
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
