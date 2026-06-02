import { onAgentEvent } from "../../infra/agent-events.js";
import {
  emitSessionTranscriptUpdate as emitTranscriptUpdate,
  onSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import type { PluginRuntime } from "./types.js";

export function emitSessionTranscriptUpdate(sessionFile: string): void {
  emitTranscriptUpdate(sessionFile);
}

export function createRuntimeEvents(): PluginRuntime["events"] {
  return {
    onAgentEvent,
    emitSessionTranscriptUpdate,
    onSessionTranscriptUpdate,
  };
}
