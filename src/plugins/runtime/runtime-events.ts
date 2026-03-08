import { onAgentEvent } from "../../infra/agent-events.js";
import { emitDiagnosticEvent, onDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeEvents(): PluginRuntime["events"] {
  return {
    onAgentEvent,
    onDiagnosticEvent,
    emitDiagnosticEvent,
    onSessionTranscriptUpdate,
  };
}
