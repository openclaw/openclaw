import { describe, expect, test } from "vitest";
import type { SerializedEventPayload } from "./node-registry.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";

describe("node subscription manager", () => {
  test("routes events with each subscribed node pairing generation", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: Array<{
      nodeId: string;
      pairingGeneration: string;
      event: string;
      payloadJSON?: SerializedEventPayload | null;
    }> = [];

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-b", "generation-b", "main");
    await manager.sendToSession("main", "chat", { ok: true }, (event) => sent.push(event));

    expect(sent).toHaveLength(2);
    expect(sent.map((event) => event.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent.map((event) => event.pairingGeneration).toSorted()).toEqual([
      "generation-a",
      "generation-b",
    ]);
  });

  test("unsubscribeAll clears both subscription indexes", async () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (event: { nodeId: string; event: string }) =>
      sent.push(`${event.nodeId}:${event.event}`);

    manager.subscribe("node-a", "generation-a", "main");
    manager.subscribe("node-a", "generation-a", "secondary");
    manager.unsubscribeAll("node-a");
    await manager.sendToSession("main", "tick", {}, sendEvent);
    await manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toStrictEqual([]);
  });
});
