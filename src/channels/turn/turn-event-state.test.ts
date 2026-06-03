import { describe, expect, it } from "vitest";
import {
  InMemoryTurnEventStore,
  materializeTurnState,
  sanitizeTurnEvent,
  sanitizeTurnEventMetadata,
  validateTurnCompletion,
  type TurnEvent,
} from "./turn-event-state.js";

const baseEvent = (overrides: Partial<TurnEvent>): TurnEvent => ({
  id: "evt",
  type: "message.received",
  timestamp: 1,
  turnId: "telegram:message:msg-1",
  actor: "runtime",
  channel: "telegram",
  ...overrides,
});

describe("turn event state", () => {
  it("stores append-only events and lists them by turn id", () => {
    const store = new InMemoryTurnEventStore({
      createId: () => "evt-1",
      now: () => 123,
    });

    const recorded = store.append({
      type: "message.received",
      turnId: "telegram:message:msg-1",
      actor: "user",
      channel: "telegram",
      status: "received",
    });

    expect(recorded).toMatchObject({
      id: "evt-1",
      timestamp: 123,
      type: "message.received",
    });
    expect(store.list("telegram:message:msg-1")).toEqual([recorded]);
    expect(store.all()).toEqual([recorded]);
  });

  it("bounds stored events while preserving append return values", () => {
    let nextId = 0;
    const store = new InMemoryTurnEventStore({
      capacity: 2,
      createId: () => `evt-${++nextId}`,
      now: () => 123,
    });

    const first = store.append({
      type: "message.received",
      turnId: "telegram:message:old",
      actor: "user",
      channel: "telegram",
    });
    const second = store.append({
      type: "message.received",
      turnId: "telegram:message:msg-1",
      actor: "user",
      channel: "telegram",
    });
    const third = store.append({
      type: "turn.started",
      turnId: "telegram:message:msg-1",
      actor: "runtime",
      channel: "telegram",
    });

    expect(first.id).toBe("evt-1");
    expect(store.all()).toEqual([second, third]);
    expect(store.list("telegram:message:old")).toEqual([]);
    expect(store.list("telegram:message:msg-1")).toEqual([second, third]);
    expect(store.stats()).toEqual({ capacity: 2, count: 2, dropped: 1 });
  });

  it("supports zero-capacity recording for diagnostics-only append flows", () => {
    const store = new InMemoryTurnEventStore({
      capacity: 0,
      createId: () => "evt-1",
      now: () => 123,
    });

    const recorded = store.append({
      type: "message.received",
      turnId: "telegram:message:msg-1",
      actor: "user",
      channel: "telegram",
    });

    expect(recorded.id).toBe("evt-1");
    expect(store.all()).toEqual([]);
    expect(store.stats()).toEqual({ capacity: 0, count: 0, dropped: 1 });
  });

  it("sanitizes event metadata before storing it", () => {
    const store = new InMemoryTurnEventStore({
      createId: () => "evt-1",
      now: () => 123,
    });

    const recorded = store.append({
      type: "message.received",
      turnId: "telegram:message:msg-1",
      actor: "user",
      channel: "telegram",
      status: "received",
      metadata: {
        messageId: "msg-1",
        rawText: "private chat text",
        apiToken: "secret-token",
        longOperationalId: "x".repeat(300),
        empty: undefined,
      },
    });

    expect(recorded.metadata).toEqual({
      messageId: "msg-1",
      rawText: "<redacted>",
      apiToken: "<redacted>",
      longOperationalId: `${"x".repeat(256)}...`,
    });
  });

  it("returns undefined sanitized metadata when every value is undefined", () => {
    expect(sanitizeTurnEventMetadata({ empty: undefined })).toBeUndefined();
  });

  it("sanitizes a returned turn event before diagnostics consume it", () => {
    expect(
      sanitizeTurnEvent(
        baseEvent({
          metadata: {
            messageId: "msg-1",
            bodyPreview: "private message body",
            operationalHint: "safe",
          },
        }),
      ).metadata,
    ).toEqual({
      messageId: "msg-1",
      bodyPreview: "<redacted>",
      operationalHint: "safe",
    });
  });

  it("blocks completion when visible delivery is required but missing", () => {
    const state = materializeTurnState([
      baseEvent({ type: "message.received", actor: "user", status: "received" }),
      baseEvent({ id: "evt-2", type: "turn.started", status: "started" }),
      baseEvent({ id: "evt-3", type: "delivery.required", status: "required" }),
    ]);

    expect(state).toMatchObject({
      currentState: "started",
      visibleDeliveryRequired: true,
      visibleDeliverySent: false,
      completionAllowed: false,
      errors: ["missing_visible_delivery"],
    });
  });

  it("allows completion after required visible delivery was sent", () => {
    const state = materializeTurnState([
      baseEvent({ type: "delivery.required", status: "required" }),
      baseEvent({ id: "evt-2", type: "delivery.sent", status: "sent" }),
      baseEvent({ id: "evt-3", type: "turn.completed", status: "valid" }),
    ]);

    expect(state).toMatchObject({
      currentState: "completed",
      visibleDeliveryRequired: true,
      visibleDeliverySent: true,
      completionAllowed: true,
      errors: [],
    });
  });

  it("keeps failed delivery visible and deduplicates repeated reasons", () => {
    const state = materializeTurnState([
      baseEvent({ type: "delivery.required", status: "required" }),
      baseEvent({
        id: "evt-2",
        type: "delivery.failed",
        status: "failed",
        metadata: { reason: "missing_visible_delivery" },
      }),
      baseEvent({
        id: "evt-3",
        type: "turn.failed",
        status: "invalid",
        metadata: { reason: "missing_visible_delivery" },
      }),
    ]);

    expect(state).toMatchObject({
      currentState: "failed",
      completionAllowed: false,
      errors: ["missing_visible_delivery"],
    });
  });

  it("validates required delivery independently from event materialization", () => {
    expect(
      validateTurnCompletion({
        currentState: "started",
        visibleDeliveryRequired: true,
        visibleDeliverySent: false,
        completionAllowed: true,
        errors: [],
      }),
    ).toEqual(["missing_visible_delivery"]);
    expect(
      validateTurnCompletion({
        currentState: "completed",
        visibleDeliveryRequired: true,
        visibleDeliverySent: true,
        completionAllowed: true,
        errors: [],
      }),
    ).toEqual([]);
  });
});
