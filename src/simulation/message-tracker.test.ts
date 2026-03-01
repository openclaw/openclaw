import { describe, expect, it } from "vitest";
import { MessageTracker } from "./message-tracker.js";
import type { SimInboundMessage, SimOutboundMessage } from "./types.js";

function inbound(
  conversationId: string,
  senderId: string,
  text = "hello",
): Omit<SimInboundMessage, "seq"> {
  return {
    id: `in-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    direction: "inbound",
    conversationId,
    text,
    senderId,
  };
}

function outbound(
  conversationId: string,
  agentId: string,
  causalParentId: string,
  causalParentTs: number,
): Omit<SimOutboundMessage, "seq"> {
  return {
    id: `out-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    direction: "outbound",
    conversationId,
    text: `reply from ${agentId}`,
    agentId,
    causalParentId,
    causalParentTs,
  };
}

describe("MessageTracker", () => {
  it("records messages with sequential seq numbers", () => {
    const tracker = new MessageTracker();
    const m1 = tracker.record(inbound("conv-1", "user-1"));
    const m2 = tracker.record(inbound("conv-1", "user-2"));
    expect(m1.seq).toBe(0);
    expect(m2.seq).toBe(1);
  });

  it("looks up messages by ID", () => {
    const tracker = new MessageTracker();
    const m1 = tracker.record(inbound("conv-1", "user-1"));
    expect(tracker.get(m1.id)).toBe(m1);
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("groups messages by conversation", () => {
    const tracker = new MessageTracker();
    tracker.record(inbound("conv-1", "user-1"));
    tracker.record(inbound("conv-2", "user-2"));
    tracker.record(inbound("conv-1", "user-3"));
    expect(tracker.conversation("conv-1")).toHaveLength(2);
    expect(tracker.conversation("conv-2")).toHaveLength(1);
    expect(tracker.conversation("conv-3")).toHaveLength(0);
  });

  it("returns all messages in insertion order", () => {
    const tracker = new MessageTracker();
    tracker.record(inbound("conv-1", "user-1"));
    tracker.record(inbound("conv-2", "user-2"));
    const all = tracker.messages();
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(0);
    expect(all[1].seq).toBe(1);
  });

  it("builds causal chain from outbound messages", () => {
    const tracker = new MessageTracker();
    const m1 = tracker.record(inbound("conv-1", "user-1"));
    const m2 = tracker.record(outbound("conv-1", "agent-1", m1.id, m1.ts));
    const chain = tracker.causalChain(m2.id);
    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe(m2.id);
    expect(chain[1].id).toBe(m1.id);
  });

  it("detects stale context messages", () => {
    const tracker = new MessageTracker();
    const m1 = tracker.record({ ...inbound("conv-1", "user-1"), ts: 1000 });
    tracker.record({ ...inbound("conv-1", "user-2"), ts: 2000 });
    tracker.record({ ...inbound("conv-1", "user-3"), ts: 3000 });
    // Agent replies based on m1, missing m2 and m3
    tracker.record({ ...outbound("conv-1", "agent-1", m1.id, m1.ts), ts: 4000 });
    const stale = tracker.staleContextMessages();
    expect(stale).toHaveLength(1);
  });

  it("reports size correctly", () => {
    const tracker = new MessageTracker();
    expect(tracker.size).toBe(0);
    tracker.record(inbound("conv-1", "user-1"));
    expect(tracker.size).toBe(1);
  });
});
