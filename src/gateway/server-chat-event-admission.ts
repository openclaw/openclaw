import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";

/** Select progress for an already-authorized hidden session subscription. */
export function shouldMirrorAgentEventToHiddenSessionMessages(
  { stream, data }: Pick<AgentEventPayload, "stream" | "data">,
  isAborted: boolean,
): boolean {
  return (
    stream === "item" ||
    stream === "thinking" ||
    stream === "approval" ||
    stream === "lifecycle" ||
    (stream === "compaction" && (data.phase === "start" || data.phase === "end")) ||
    (!isAborted &&
      stream === "assistant" &&
      ((typeof data.text === "string" && data.text.length > 0) ||
        (typeof data.delta === "string" && data.delta.length > 0)) &&
      resolveAssistantEventPhase(data) === "commentary")
  );
}

/** Deliver events only while their live producer belongs to this Gateway. */
export function createAgentEventAdmission({
  handleEvent,
  isCurrent,
  dispose,
}: {
  handleEvent: (event: AgentEventPayload) => void;
  isCurrent: (event: AgentEventRuntimePayload) => boolean;
  dispose: () => void;
}) {
  let closed = false;
  return Object.assign(
    (event: AgentEventRuntimePayload) =>
      runOutsideAsyncWorkScope(() => {
        if (!closed && isCurrent(event)) {
          handleEvent(event);
        }
      }),
    {
      dispose: async () => {
        closed = true;
        dispose();
      },
    },
  );
}
