import { describe, expect, test, vi } from "vitest";
import type { SerializedEventPayload } from "./node-registry.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";

describe("node subscription manager", () => {
  test("routes events and tracks demand across pairing-fenced subscriptions", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: Array<{
      nodeId: string;
      pairingGeneration: string;
      event: string;
      payloadJSON?: SerializedEventPayload | null;
    }> = [];
    const sendEvent = (event: (typeof sent)[number]) => {
      sent.push(event);
    };

    expect(manager.hasSubscribers("main")).toBe(false);
    expect(manager.hasSubscribers("  ")).toBe(false);
    manager.subscribe("node-a", "generation-a", " main ");
    manager.subscribe("node-b", "generation-b", "main");
    expect(manager.hasSubscribers(" main ")).toBe(true);
    expect(manager.hasSubscribers("Main")).toBe(false);
    await manager.sendToSession("main", "chat", { ok: true }, sendEvent);

    expect(sent.map((event) => event.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent.map((event) => event.pairingGeneration).toSorted()).toEqual([
      "generation-a",
      "generation-b",
    ]);

    sent.length = 0;
    manager.unsubscribe("node-a", "generation-a", " main ");
    manager.unsubscribe("node-b", "stale-generation", "main");
    expect(manager.hasSubscribers("main")).toBe(true);
    await manager.sendToSession("main", "chat", { ok: true }, sendEvent);
    expect(sent.map((event) => event.nodeId)).toEqual(["node-b"]);

    sent.length = 0;
    manager.unsubscribe("node-b", "generation-b", "main");
    expect(manager.hasSubscribers("main")).toBe(false);
    await manager.sendToSession("main", "chat", { ok: true }, sendEvent);
    expect(sent).toEqual([]);
  });

  test("unsubscribeAll clears both subscription indexes", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (event: { nodeId: string; event: string }) => {
      sent.push(`${event.nodeId}:${event.event}`);
    };

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-a", "generation-a", "secondary");
    manager.unsubscribeAll("node-a", "stale-generation");
    expect(manager.hasSubscribers("main")).toBe(true);
    expect(manager.hasSubscribers("secondary")).toBe(true);
    manager.unsubscribeAll("node-a");
    expect(manager.hasSubscribers("main")).toBe(false);
    expect(manager.hasSubscribers("secondary")).toBe(false);
    await manager.sendToSession("main", "tick", {}, sendEvent);
    await manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toStrictEqual([]);
  });

  test("settles sender failures without rejecting fire-and-forget fanout", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-b", "generation-b", "main");
    await expect(
      manager.sendToSession("main", "tick", {}, ({ nodeId }) => {
        if (nodeId === "node-a") {
          throw new Error("transport failed");
        }
        sent.push(nodeId);
      }),
    ).resolves.toBeUndefined();

    expect(sent).toStrictEqual(["node-b"]);
  });

  test("drops unserializable payloads without rejecting fanout", async () => {
    const manager = createNodeSubscriptionManager();
    const sendEvent = vi.fn();

    manager.subscribe("node-a", "generation-a", "main");
    await expect(
      manager.sendToSession("main", "tick", { invalid: 1n }, sendEvent),
    ).resolves.toBeUndefined();

    expect(sendEvent).not.toHaveBeenCalled();
  });
});
