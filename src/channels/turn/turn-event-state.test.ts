import { describe, expect, it } from "vitest";
import {
  InMemoryTurnEventStore,
  materializeTurnState,
  validateTurnCompletion,
} from "./turn-event-state.js";

describe("turn event state", () => {
  it("blocks completion when required delivery was not sent", () => {
    const store = new InMemoryTurnEventStore({ now: () => 1, createId: () => "evt" });
    store.append({
      type: "message.received",
      turnId: "telegram:message:msg-1",
      actor: "user",
      channel: "telegram",
      status: "received",
    });
    store.append({
      type: "turn.started",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
      status: "started",
    });
    store.append({
      type: "delivery.required",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
      status: "required",
    });

    const state = materializeTurnState(store.list("telegram:message:msg-1"));

    expect(state.visibleDeliveryRequired).toBe(true);
    expect(state.visibleDeliverySent).toBe(false);
    expect(state.completionAllowed).toBe(false);
    expect(validateTurnCompletion(state)).toEqual(["missing_visible_delivery"]);
  });

  it("allows completion after required delivery was sent", () => {
    const store = new InMemoryTurnEventStore({ now: () => 1 });
    store.append({
      type: "delivery.required",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
      status: "required",
    });
    store.append({
      type: "delivery.sent",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
      status: "sent",
    });
    store.append({
      type: "turn.completed",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
      status: "valid",
    });

    const state = materializeTurnState(store.list("telegram:message:msg-1"));

    expect(state.currentState).toBe("completed");
    expect(state.completionAllowed).toBe(true);
    expect(validateTurnCompletion(state)).toEqual([]);
  });

  it("keeps delivery failures visible in materialized state", () => {
    const state = materializeTurnState([
      {
        id: "evt-1",
        type: "delivery.required",
        timestamp: 1,
        turnId: "telegram:message:msg-1",
        actor: "runtime",
        channel: "telegram",
        status: "required",
      },
      {
        id: "evt-2",
        type: "delivery.failed",
        timestamp: 2,
        turnId: "telegram:message:msg-1",
        actor: "runtime",
        channel: "telegram",
        status: "failed",
        metadata: { reason: "missing_visible_delivery" },
      },
    ]);

    expect(state.currentState).toBe("failed");
    expect(state.completionAllowed).toBe(false);
    expect(state.errors).toContain("missing_visible_delivery");
  });

  it("models tool call/result causality inside the same turn", () => {
    const store = new InMemoryTurnEventStore({ now: () => 1 });
    const called = store.append({
      id: "tool-call-1",
      type: "tool.called",
      turnId: "telegram:message:msg-1",
      actor: "agent",
      channel: "telegram",
      status: "started",
      metadata: { tool: "message.send" },
    });
    const result = store.append({
      type: "tool.result",
      turnId: "telegram:message:msg-1",
      parentId: called.id,
      actor: "tool",
      channel: "telegram",
      status: "completed",
      metadata: { tool: "message.send" },
    });

    expect(result.parentId).toBe("tool-call-1");
    expect(store.list("telegram:message:msg-1").map((event) => event.type)).toEqual([
      "tool.called",
      "tool.result",
    ]);
  });
});
