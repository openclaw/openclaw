// Tests that compact inbound history keeps session transcript rows the session does not replay.
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildCompactInboundUserContextPrefix } from "./inbound-meta.js";

function buildWithWindow(messages: Array<Record<string, unknown>>) {
  return buildCompactInboundUserContextPrefix({
    ChatType: "direct",
    MessageSid: "current",
    SenderName: "Onur",
    SenderId: "user-1",
    Timestamp: 2_000,
    ChannelStructuredContext: [
      {
        label: "Conversation context",
        source: "session",
        type: "chat_window",
        payload: {
          order: "chronological",
          relation: "selected_for_current_message",
          messages,
        },
      },
    ],
  } as TemplateContext);
}

describe("compact inbound history and session transcript rows", () => {
  it("keeps a delivered cron close-out that only the session transcript holds", () => {
    const projection = buildWithWindow([
      { message_id: "session:cron-1", sender: "Assistant (cron)", body: "Weekly report: total 42" },
      { message_id: "session:u2", sender: "User", body: "send that again with the totals" },
    ]);

    expect(projection.text).toContain("Weekly report: total 42");
    expect(projection.text).toContain("send that again with the totals");
    expect(projection.removedSessionMessages).toBe(0);
  });

  it("still removes a session row that repeats a native row of the same window", () => {
    const projection = buildWithWindow([
      { message_id: "session:u1", sender: "User", body: "same text" },
      { message_id: "native-1", sender: "Alice", body: "same text" },
    ]);

    expect(projection.text).not.toContain("session:u1");
    expect(projection.text).toContain("#native-1 Alice: same text");
    expect(projection.removedSessionMessages).toBe(1);
  });
});
