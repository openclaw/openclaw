// Tests that compact inbound history keeps session transcript rows the session does not replay.
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildCompactInboundUserContextPrefix } from "./inbound-meta.compact.js";

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
      { message_id: "session:u1", sender: "User", body: "same text", timestamp_ms: 1_000 },
      { message_id: "native-1", sender: "Alice", body: "same text", timestamp_ms: 1_000 },
    ]);

    expect(projection.text).not.toContain("session:u1");
    expect(projection.text).toContain("#native-1 Alice: same text");
    expect(projection.removedSessionMessages).toBe(1);
  });

  it("keeps distinct bodies that render the same at the same timestamp", () => {
    const projection = buildWithWindow([
      { message_id: "native-1", sender: "Alice", body: "status ready", timestamp_ms: 1_000 },
      { message_id: "session:x", sender: "Assistant", body: "status\nready", timestamp_ms: 1_000 },
    ]);

    expect(projection.text).toContain("#native-1 Alice: status ready");
    expect(projection.text).toContain("#session:x Assistant: status ready");
    expect(projection.removedSessionMessages).toBe(0);
  });

  it("keeps a transcript-only session row of InboundHistory and drops one a native entry repeats", () => {
    const projection = buildCompactInboundUserContextPrefix({
      ChatType: "direct",
      MessageSid: "current",
      SenderName: "Onur",
      SenderId: "user-1",
      Timestamp: 2_000,
      InboundHistory: [
        {
          messageId: "session:cron-1",
          sender: "Assistant (cron)",
          body: "Weekly report: total 42",
          timestamp: 1,
        },
        { messageId: "session:u1", sender: "User", body: "same text", timestamp: 2 },
        { messageId: "native-1", sender: "Alice", body: "same text", timestamp: 2 },
      ],
    } as TemplateContext);

    expect(projection.text).toContain("Weekly report: total 42");
    expect(projection.text).not.toContain("session:u1");
    expect(projection.text).toContain("#native-1 Alice: same text");
    expect(projection.removedSessionMessages).toBe(1);
  });

  it("keeps a transcript-only assistant row whose body equals a native row of another speaker", () => {
    const projection = buildWithWindow([
      { message_id: "100", sender: "alice", body: "ok", timestamp_ms: 1_000 },
      { message_id: "session:x", sender: "Assistant", body: "ok", timestamp_ms: 1_500 },
    ]);

    expect(projection.text).toContain("#100 alice: ok");
    expect(projection.text).toContain("#session:x Assistant: ok");
    expect(projection.removedSessionMessages).toBe(0);
  });

  it("keeps a session row of InboundHistory that only shares its body with a native entry", () => {
    const projection = buildCompactInboundUserContextPrefix({
      ChatType: "direct",
      MessageSid: "current",
      SenderName: "Onur",
      SenderId: "user-1",
      Timestamp: 2_000,
      InboundHistory: [
        { messageId: "100", sender: "alice", body: "ok", timestamp: 1 },
        { messageId: "session:x", sender: "Assistant", body: "ok", timestamp: 5 },
      ],
    } as TemplateContext);

    expect(projection.text).toContain("#session:x Assistant: ok");
    expect(projection.removedSessionMessages).toBe(0);
  });
});
