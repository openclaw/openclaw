import { onAgentEvent } from "../../infra/agent-events.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeEvents(): PluginRuntime["events"] {
  return {
    onAgentEvent,
    onSessionTranscriptUpdate,
  };
}
