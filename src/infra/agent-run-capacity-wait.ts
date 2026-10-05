import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { bumpAgentRunIndexVersion } from "./agent-run-registry-state.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "./agent-run-registry.js";

export function isAgentRunWaitingForCapacity(runId: string): boolean {
  const context = getAgentRunContext(runId);
  return (
    context !== undefined &&
    context.lifecycleGeneration === getAgentRunLifecycleGeneration() &&
    (context.capacityWaits?.size ?? 0) > 0
  );
}

/** Capture the scheduler's exact context; a recycled run id cannot donate wait time. */
export function captureAgentRunCapacityWait(runId: string, lifecycleGeneration: string) {
  const context = getAgentRunContext(runId);
  return () => {
    if (
      !context ||
      getAgentRunContext(runId) !== context ||
      context.lifecycleGeneration !== lifecycleGeneration ||
      lifecycleGeneration !== getAgentRunLifecycleGeneration()
    ) {
      return undefined;
    }
    return {
      waiting: (context.capacityWaits?.size ?? 0) > 0,
      elapsedMs:
        (context.capacityWaitClock?.elapsedMs ?? 0) +
        (context.capacityWaitClock?.startedAtMs === undefined
          ? 0
          : Math.max(0, Date.now() - context.capacityWaitClock.startedAtMs)),
    };
  };
}

/** Records a scheduler-owned wait and releases only the exact captured run instance. */
export function registerAgentRunCapacityWait(
  runId: string,
  lifecycleGeneration: string,
): (() => void) | undefined {
  const context = getAgentRunContext(runId);
  if (
    !context ||
    context.lifecycleGeneration !== lifecycleGeneration ||
    lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    return undefined;
  }
  const waits = (context.capacityWaits ??= new Set());
  const clock = (context.capacityWaitClock ??= { elapsedMs: 0 });
  const token = Symbol("agent-run-capacity-wait");
  const publish = () => {
    bumpAgentRunIndexVersion(context);
    if (
      context.sessionKey &&
      context.projectSessionLifecycle !== false &&
      context.projectSessionActive !== false
    ) {
      emitSessionLifecycleEvent({
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        reason: "run-capacity",
        scope: "runtime",
      });
    }
  };
  waits.add(token);
  if (waits.size === 1) {
    clock.startedAtMs = Date.now();
    publish();
  }
  return () => {
    // Queue cancellation and lifecycle rotation can outlive a recycled run id.
    // A stale callback must never publish or clear a replacement's wait state.
    if (
      getAgentRunContext(runId) !== context ||
      context.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
      !waits.delete(token) ||
      waits.size > 0
    ) {
      return;
    }
    delete context.capacityWaits;
    clock.elapsedMs += Math.max(0, Date.now() - (clock.startedAtMs ?? Date.now()));
    clock.startedAtMs = undefined;
    publish();
  };
}
