import type { EmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createReplyTimingTracker, REPLY_PROFILER_STAGE_WARN_MS } from "./reply-timing-tracker.js";

type AgentTurnLogContext = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
};
type AgentTurnTerminalLogParams = AgentTurnLogContext & {
  outcome: "completed" | "error";
  error?: string;
};
type AgentTurnMilestoneLogParams = AgentTurnLogContext & { milestone: string };
type AgentTurnLogParams = AgentTurnTerminalLogParams | AgentTurnMilestoneLogParams;

const agentTurnTimingLog = createSubsystemLogger("auto-reply/agent-turn-timing");

function hasSlowProfilingStage(details: Record<string, unknown> | undefined): boolean {
  const spans = details?.spans;
  return (
    Array.isArray(spans) &&
    spans.some(
      (stage) =>
        typeof stage === "object" &&
        stage !== null &&
        "durationMs" in stage &&
        typeof stage.durationMs === "number" &&
        stage.durationMs >= REPLY_PROFILER_STAGE_WARN_MS,
    )
  );
}

export function createAgentTurnTimingTracker(options: { profilerEnabled?: boolean } = {}) {
  const observedExecutionPhases = new Set<EmbeddedAgentExecutionPhase>();
  const timing = createReplyTimingTracker<AgentTurnLogParams>({
    log: {
      warn(message, details) {
        const isOutputMilestone =
          details?.milestone === "assistant_output_started" ||
          details?.milestone === "tool_execution_started";
        // Completed turns and provider/tool latency are context, not warnings;
        // a completed turn still warns when one stage crosses the profiling threshold.
        const isQuietCompletedTurn =
          details !== undefined &&
          details.outcome === "completed" &&
          !details.error &&
          !hasSlowProfilingStage(details);
        if (isQuietCompletedTurn || (isOutputMilestone && !options.profilerEnabled)) {
          agentTurnTimingLog.info(message, details);
        } else {
          agentTurnTimingLog.warn(message, details);
        }
      },
    },
    enabled: options.profilerEnabled === true,
    formatMessage: (params, summary, stages) => {
      const identity = `runId=${params.runId} sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"}`;
      return "milestone" in params
        ? `agent turn milestone ${identity} milestone=${params.milestone} totalMs=${summary.totalMs} stages=${stages}`
        : `agent turn timings ${identity} outcome=${params.outcome} totalMs=${summary.totalMs} stages=${stages}${params.error ? ` error="${params.error}"` : ""}`;
    },
    detailKeys: (params) =>
      "milestone" in params
        ? ["runId", "sessionId", "sessionKey", "milestone"]
        : ["runId", "sessionId", "sessionKey", "outcome", "error"],
  });
  return {
    observe(observer?: () => (() => void) | undefined) {
      try {
        const finish = observer?.();
        return finish
          ? {
              [Symbol.dispose]() {
                try {
                  finish();
                } catch {
                  // Timing observers cannot change the work they observe.
                }
              },
            }
          : undefined;
      } catch {
        return undefined;
      }
    },
    measure: timing.measure,
    measureSync: timing.measureSync,
    logIfSlow(params: AgentTurnTerminalLogParams) {
      // The terminal duration includes inference and tools; only failed turns
      // warn, while completed timings stay informational.
      if (!options.profilerEnabled) {
        return;
      }
      const { runId, sessionId, sessionKey, outcome, error } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, outcome, error });
    },
    logMilestoneIfSlow(params: AgentTurnMilestoneLogParams) {
      const { runId, sessionId, sessionKey, milestone } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, milestone }, { repeat: true });
    },
    logExecutionPhaseIfSlow(params: AgentTurnLogContext & { phase: EmbeddedAgentExecutionPhase }) {
      // Each phase is a first-observation boundary, not a log for every tool
      // or retry. The fixed phase vocabulary bounds this per-turn state.
      if (observedExecutionPhases.has(params.phase)) {
        return;
      }
      observedExecutionPhases.add(params.phase);
      const { runId, sessionId, sessionKey, phase: milestone } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, milestone }, { repeat: true });
    },
  };
}

export type AgentTurnTimingTracker = ReturnType<typeof createAgentTurnTimingTracker>;
