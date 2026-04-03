import type { SupervisorInterruptibility, SupervisorTaskState } from "./types.js";

function inferInterruptibility(params: {
  isActive: boolean;
  isStreaming: boolean;
}): SupervisorInterruptibility {
  if (!params.isActive) {
    return "interruptible";
  }
  return params.isStreaming ? "interruptible" : "atomic";
}

export function inferSupervisorTaskState(params: {
  sessionKey: string;
  sessionId: string;
  isActive: boolean;
  isStreaming: boolean;
  laneSize: number;
}): SupervisorTaskState {
  return {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    phase: !params.isActive ? "idle" : params.isStreaming ? "acting" : "planning",
    interruptPreference: "avoid",
    interruptibility: inferInterruptibility(params),
    isActive: params.isActive,
    isStreaming: params.isStreaming,
    laneSize: params.laneSize,
  };
}
