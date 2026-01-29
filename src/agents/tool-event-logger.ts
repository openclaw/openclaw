import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/tools");

export type AgentEventData = { stream: string; data: Record<string, unknown> };

/**
 * Handle tool events from onAgentEvent callback.
 * Call this from onAgentEvent handlers to get consistent tool logging.
 */
export function logToolEvent(evt: AgentEventData, runId?: string): void {
  if (evt.stream !== "tool") return;

  const phase = evt.data.phase as string | undefined;
  const toolName = (evt.data.name as string | undefined) ?? "unknown";
  const toolCallId = (evt.data.toolCallId as string | undefined) ?? "";

  switch (phase) {
    case "start":
      log.debug(`tool start: ${toolName}`, {
        runId,
        toolCallId,
        args: evt.data.args,
      });
      break;
    case "result": {
      const isError = Boolean(evt.data.isError);
      if (isError) {
        const result = evt.data.result ?? evt.data.resultText;
        const errorPreview =
          typeof result === "string" ? result.slice(0, 500) : String(result).slice(0, 500);
        log.warn(`tool failed: ${toolName}`, {
          runId,
          toolCallId,
          error: errorPreview,
        });
      } else {
        log.debug(`tool complete: ${toolName}`, { runId, toolCallId });
      }
      break;
    }
  }
}
