import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";

describe("qa-bus state", () => {
  it("records inbound and outbound traffic in cursor order", () => {
    const state = createQaBusState();

    const inbound = state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "hello",
    });
    const outbound = state.addOutboundMessage({
      to: "dm:alice",
      text: "hi",
    });

    const snapshot = state.getSnapshot();
    expect(snapshot.cursor).toBe(2);
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "inbound-message",
      "outbound-message",
    ]);
    expect(snapshot.messages.map((message) => message.id)).toEqual([inbound.id, outbound.id]);
  });

  it("creates threads and mutates message state", async () => {
    const state = createQaBusState();

    const thread = state.createThread({
      conversationId: "qa-room",
      title: "QA thread",
    });
    const message = state.addOutboundMessage({
      to: `thread:qa-room/${thread.id}`,
      text: "inside thread",
      threadId: thread.id,
    });

    state.reactToMessage({
      messageId: message.id,
      emoji: "white_check_mark",
    });
    state.editMessage({
      messageId: message.id,
      text: "inside thread (edited)",
    });
    state.deleteMessage({
      messageId: message.id,
    });

    const updated = state.readMessage({ messageId: message.id });
    expect(updated.threadId).toBe(thread.id);
    expect(updated.reactions).toHaveLength(1);
    expect(updated.text).toContain("(edited)");
    expect(updated.deleted).toBe(true);

    const waited = await state.waitFor({
      kind: "thread-id",
      threadId: thread.id,
      timeoutMs: 50,
    });
    expect("id" in waited && waited.id).toBe(thread.id);
  });

  it("replays fresh events after a reset rewinds the cursor", () => {
    const state = createQaBusState();

    state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "before reset",
    });
    const beforeReset = state.poll({
      accountId: "default",
      cursor: 0,
    });
    expect(beforeReset.events).toHaveLength(1);

    state.reset();
    state.addInboundMessage({
      conversation: { id: "alice", kind: "direct" },
      senderId: "alice",
      text: "after reset",
    });

    const afterReset = state.poll({
      accountId: "default",
      cursor: beforeReset.cursor,
    });
    expect(afterReset.events).toHaveLength(1);
    expect(afterReset.events[0]?.kind).toBe("inbound-message");
    expect(
      afterReset.events[0] &&
        "message" in afterReset.events[0] &&
        afterReset.events[0].message.text,
    ).toBe("after reset");
  });
});
