import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { projectAgentHistoryActivity } from "../../../src/infra/agent-activity-events.js";
import {
  nestedToolActivityContent,
  readNestedToolActivity,
} from "../../../src/sessions/nested-tool-activity.js";

/** Prepare only scenarios that model the Gateway's history projection boundary. */
export function prepareChatHistoryFixture(messages: Record<string, unknown>[]) {
  const entries = messages.map((message, index) => {
    const metadata = asOptionalRecord(message["__openclaw"]);
    const messageId = message.messageId ?? metadata?.id ?? `fixture-message-${index}`;
    if (typeof messageId !== "string") {
      throw new Error("History fixture message ID must be a string");
    }
    return {
      messageId,
      message: { ...message, __openclaw: { ...metadata, id: messageId } },
    };
  });
  return {
    messages: entries.map(({ message }) => {
      const nested = readNestedToolActivity(message);
      if (!nested) {
        return message;
      }
      // Prepare activity from the canonical row before publishing its display blocks.
      const [call, result] = nestedToolActivityContent(nested);
      return { ...message, content: [call, { ...result, role: "toolResult" }] };
    }),
    activity: projectAgentHistoryActivity(entries),
  };
}
