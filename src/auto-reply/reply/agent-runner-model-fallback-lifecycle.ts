import { emitAgentEvent } from "../../infra/agent-events.js";

export function emitModelFallbackStepLifecycle(params: {
  runId: string;
  sessionKey?: string;
  step: Record<string, unknown>;
  emitEvent?: typeof emitAgentEvent;
}) {
  (params.emitEvent ?? emitAgentEvent)({
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    stream: "lifecycle",
    data: { phase: "fallback_step", ...params.step },
  });
}
