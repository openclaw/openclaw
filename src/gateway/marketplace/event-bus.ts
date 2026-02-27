/**
 * Marketplace event bus — routes proxy events from seller nodes
 * to the buyer's HTTP request handler.
 *
 * When a seller node sends `node.event({ event: "marketplace.proxy.chunk", ... })`,
 * the gateway's event handler dispatches it here. The marketplace HTTP handler
 * subscribes to events for a specific requestId and relays them to the buyer.
 *
 * Also routes idle status changes from nodes to the scheduler.
 */
import { EventEmitter } from "node:events";

export type MarketplaceProxyEventKind = "chunk" | "done" | "error";

export type MarketplaceProxyEvent = {
  nodeId: string;
  requestId: string;
  kind: MarketplaceProxyEventKind;
  payload: Record<string, unknown>;
};

export type MarketplaceIdleEvent = {
  nodeId: string;
  status: "active" | "idle" | "sharing";
  maxConcurrent?: number;
};

class MarketplaceEventBus extends EventEmitter {
  emitProxy(evt: MarketplaceProxyEvent): void {
    this.emit(`proxy:${evt.requestId}`, evt);
  }

  onProxy(requestId: string, handler: (evt: MarketplaceProxyEvent) => void): () => void {
    this.on(`proxy:${requestId}`, handler);
    return () => {
      this.removeListener(`proxy:${requestId}`, handler);
    };
  }

  emitIdleStatus(evt: MarketplaceIdleEvent): void {
    this.emit("idle-status", evt);
  }

  onIdleStatus(handler: (evt: MarketplaceIdleEvent) => void): () => void {
    this.on("idle-status", handler);
    return () => {
      this.removeListener("idle-status", handler);
    };
  }
}

export const marketplaceEventBus = new MarketplaceEventBus();
