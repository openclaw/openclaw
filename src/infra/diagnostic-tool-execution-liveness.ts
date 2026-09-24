import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type DiagnosticToolExecutionLiveness = Readonly<{ deadlineAtMs?: number }>;
export const TOOL_EXECUTION_LIVENESS_METADATA_KEY = "toolExecutionLiveness";

// Released runtime chunks still call this carrier while their invocations drain.
type ToolExecutionDeadlineOwner = ((deadlineAtMs: number | undefined) => void) & {
  register?: (deadlineAtMs: number) => () => void;
};

const state = resolveGlobalSingleton(
  Symbol.for("openclaw.diagnosticToolExecutionLiveness"),
  () => ({
    context: new AsyncLocalStorage<ToolExecutionDeadlineOwner>(),
    events: new WeakMap<object, DiagnosticToolExecutionLiveness>(),
  }),
);

/** The invocation owns the reference; only its execution owner supplies a deadline. */
export function createDiagnosticToolExecutionLiveness(signal?: AbortSignal) {
  let active = true;
  let deadlineAtMs: number | undefined;
  const waits = new Map<object, number>();
  const view: DiagnosticToolExecutionLiveness = Object.freeze({
    get deadlineAtMs() {
      if (signal?.aborted) {
        return undefined;
      }
      let latestDeadline = deadlineAtMs;
      for (const deadline of waits.values()) {
        latestDeadline = Math.max(latestDeadline ?? deadline, deadline);
      }
      return latestDeadline;
    },
  });
  const record: ToolExecutionDeadlineOwner = (deadline) => {
    if (active && !signal?.aborted) {
      deadlineAtMs = deadline;
    }
  };
  record.register = (deadline) => {
    const wait = {};
    if (active && !signal?.aborted && Number.isFinite(deadline)) {
      waits.set(wait, deadline);
    }
    return () => {
      waits.delete(wait);
    };
  };
  return {
    view,
    run<T>(execute: () => T): T {
      return state.context.run(record, execute);
    },
    close() {
      active = false;
      waits.clear();
      // The queued terminal retires the marker. Preserve exec's fixed allowance
      // until then, without letting a retained callback extend it.
    },
  };
}

export function recordDiagnosticToolExecutionDeadline(deadlineAtMs: number | undefined): void {
  state.context.getStore()?.(deadlineAtMs);
}

/** The enforced response wait owns this allowance, independently of overlapping waits. */
export function registerDiagnosticToolExecutionDeadline(
  deadlineAtMs: number,
): (() => void) | undefined {
  return state.context.getStore()?.register?.(deadlineAtMs);
}

/** Keep the live reference out of the cloned, plugin-facing event payload. */
export function markToolExecutionLivenessDiagnosticEvent<
  T extends { type: "tool.execution.started" },
>(event: T, liveness: DiagnosticToolExecutionLiveness): T {
  state.events.set(event, liveness);
  return event;
}

export function consumeToolExecutionLivenessDiagnosticEvent(
  event: object,
): DiagnosticToolExecutionLiveness | undefined {
  const liveness = state.events.get(event);
  state.events.delete(event);
  return liveness;
}

export function resolveToolExecutionLivenessDiagnosticMetadata(
  metadata: Readonly<{
    trusted: boolean;
    [TOOL_EXECUTION_LIVENESS_METADATA_KEY]?: DiagnosticToolExecutionLiveness;
  }>,
): DiagnosticToolExecutionLiveness | undefined {
  return metadata.trusted ? metadata[TOOL_EXECUTION_LIVENESS_METADATA_KEY] : undefined;
}
