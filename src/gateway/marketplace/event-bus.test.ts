import { describe, it, expect, vi, afterEach } from "vitest";
import {
  marketplaceEventBus,
  type MarketplaceProxyEvent,
  type MarketplaceIdleEvent,
} from "./event-bus.js";

describe("MarketplaceEventBus", () => {
  afterEach(() => {
    marketplaceEventBus.removeAllListeners();
  });

  describe("proxy events", () => {
    it("routes events to the correct requestId subscriber", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      marketplaceEventBus.onProxy("req-1", handler1);
      marketplaceEventBus.onProxy("req-2", handler2);

      const evt: MarketplaceProxyEvent = {
        nodeId: "node-1",
        requestId: "req-1",
        kind: "chunk",
        payload: { data: "hello" },
      };
      marketplaceEventBus.emitProxy(evt);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler1).toHaveBeenCalledWith(evt);
      expect(handler2).not.toHaveBeenCalled();
    });

    it("handles chunk, done, and error event kinds", () => {
      const events: MarketplaceProxyEvent[] = [];
      marketplaceEventBus.onProxy("req-1", (evt) => events.push(evt));

      const chunk: MarketplaceProxyEvent = {
        nodeId: "node-1",
        requestId: "req-1",
        kind: "chunk",
        payload: { data: '{"text":"hi"}' },
      };
      const done: MarketplaceProxyEvent = {
        nodeId: "node-1",
        requestId: "req-1",
        kind: "done",
        payload: {
          inputTokens: 100,
          outputTokens: 50,
          durationMs: 3000,
          model: "claude-sonnet-4-20250514",
        },
      };
      const error: MarketplaceProxyEvent = {
        nodeId: "node-1",
        requestId: "req-1",
        kind: "error",
        payload: { message: "proxy failed" },
      };

      marketplaceEventBus.emitProxy(chunk);
      marketplaceEventBus.emitProxy(done);
      marketplaceEventBus.emitProxy(error);

      expect(events).toHaveLength(3);
      expect(events[0].kind).toBe("chunk");
      expect(events[1].kind).toBe("done");
      expect(events[2].kind).toBe("error");
    });

    it("unsubscribe function removes handler", () => {
      const handler = vi.fn();
      const unsubscribe = marketplaceEventBus.onProxy("req-1", handler);

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId: "req-1",
        kind: "chunk",
        payload: { data: "first" },
      });
      expect(handler).toHaveBeenCalledOnce();

      unsubscribe();

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId: "req-1",
        kind: "chunk",
        payload: { data: "second" },
      });
      expect(handler).toHaveBeenCalledOnce(); // Still 1, not called again.
    });

    it("supports multiple subscribers for the same requestId", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      marketplaceEventBus.onProxy("req-1", handler1);
      marketplaceEventBus.onProxy("req-1", handler2);

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId: "req-1",
        kind: "chunk",
        payload: { data: "broadcast" },
      });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });
  });

  describe("idle status events", () => {
    it("emits and receives idle status events", () => {
      const handler = vi.fn();
      marketplaceEventBus.onIdleStatus(handler);

      const evt: MarketplaceIdleEvent = {
        nodeId: "node-1",
        status: "idle",
        maxConcurrent: 2,
      };
      marketplaceEventBus.emitIdleStatus(evt);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(evt);
    });

    it("unsubscribe function removes idle status handler", () => {
      const handler = vi.fn();
      const unsubscribe = marketplaceEventBus.onIdleStatus(handler);

      marketplaceEventBus.emitIdleStatus({
        nodeId: "node-1",
        status: "idle",
      });
      expect(handler).toHaveBeenCalledOnce();

      unsubscribe();

      marketplaceEventBus.emitIdleStatus({
        nodeId: "node-1",
        status: "active",
      });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("handles status transitions", () => {
      const statuses: string[] = [];
      marketplaceEventBus.onIdleStatus((evt) => statuses.push(evt.status));

      marketplaceEventBus.emitIdleStatus({ nodeId: "node-1", status: "idle" });
      marketplaceEventBus.emitIdleStatus({ nodeId: "node-1", status: "sharing" });
      marketplaceEventBus.emitIdleStatus({ nodeId: "node-1", status: "active" });

      expect(statuses).toEqual(["idle", "sharing", "active"]);
    });
  });
});
