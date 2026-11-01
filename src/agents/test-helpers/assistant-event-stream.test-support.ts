import type { AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";

export function createQueuedAssistantStream(
  produce: (push: (event: AssistantMessageEvent) => void) => void,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    produce((event) => stream.push(event));
    stream.end();
  });
  return stream;
}
