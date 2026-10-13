import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import type { GatewayRequestContext } from "./types.js";

const diagnostics = channel("openclaw.projects.list");

export function startProjectsListDiagnostics(context: GatewayRequestContext) {
  if (!areDiagnosticsEnabledForProcess() && !diagnostics.hasSubscribers) {
    return undefined;
  }
  const timing = createStageTimingTracker(() => performance.now());
  let phase = "registry";
  const mark = (next: string) => {
    timing.mark(phase);
    phase = next;
  };
  return {
    mark,
    finish() {
      timing.mark(phase);
      const { totalMs, stages } = timing.snapshot();
      const fields = {
        operation: "projects.list",
        elapsedMs: totalMs,
        phaseDurationsMs: Object.fromEntries(
          stages.map(({ name, durationMs }) => [name, durationMs]),
        ),
      };
      try {
        if (diagnostics.hasSubscribers) {
          diagnostics.publish(fields);
        }
        if (totalMs >= 1_000 && areDiagnosticsEnabledForProcess()) {
          context.logGateway?.warn("projects.list: slow request", fields);
        }
      } catch {
        // Diagnostics cannot replace a response or the original failure.
      }
    },
  };
}
