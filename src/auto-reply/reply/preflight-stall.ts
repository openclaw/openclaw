import { resolveCompactionTimeoutMs } from "../../agents/embedded-agent-runner/compaction-safety-timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { formatCompactionModelRef } from "./compaction-notice.js";

/**
 * Bounds a reply's private memory flush by the same progress window as compaction.
 * Output deltas reset it. Expiry aborts only the optional flush, which then fails
 * non-fatally like any other flush failure, so the reply continues.
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
  let stall: Error | undefined;
  const timer = setTimeout(() => {
    stall = new Error(
      `memory flush timed out on ${modelRef} after ${Math.round(windowMs / 1000)}s without output`,
    );
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
    stop() {
      clearTimeout(timer);
    },
  };
}
