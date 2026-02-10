import { describe, expect, test, vi } from "vitest";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";

describe("node subscription manager", () => {
  test("routes events to subscribed nodes", () => {
    const manager = createNodeSubscriptionManager();
    const sent: Array<{
      nodeId: string;
      event: string;
      payloadJSON?: string | null;
    }> = [];
    const sendEvent = (evt: { nodeId: string; event: string; payloadJSON?: string | null }) =>
      sent.push(evt);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-b", "main");
    manager.sendToSession("main", "chat", { ok: true }, sendEvent);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent[0].event).toBe("chat");
  });

  test("unsubscribeAll clears session mappings", () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (evt: { nodeId: string; event: string }) =>
      sent.push(`${evt.nodeId}:${evt.event}`);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-a", "secondary");
    manager.unsubscribeAll("node-a");
    manager.sendToSession("main", "tick", {}, sendEvent);
    manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toEqual([]);
  });

  test("getSessionKeysForNode returns subscribed session keys", () => {
    const manager = createNodeSubscriptionManager();
    manager.subscribe("node-a", "agent:main:discord:channel:123");
    manager.subscribe("node-a", "agent:main:slack:channel:456");

    const keys = manager.getSessionKeysForNode("node-a");

    expect(keys).toHaveLength(2);
    expect(keys).toContain("agent:main:discord:channel:123");
    expect(keys).toContain("agent:main:slack:channel:456");
  });

  test("getSessionKeysForNode returns empty for unknown node", () => {
    const manager = createNodeSubscriptionManager();
    expect(manager.getSessionKeysForNode("unknown")).toEqual([]);
  });

  test("onSubscribe is called when first subscriber is added", () => {
    const onSubscribe = vi.fn();
    const manager = createNodeSubscriptionManager({ onSubscribe });

    manager.subscribe("node-a", "session-1");

    expect(onSubscribe).toHaveBeenCalledWith("node-a", "session-1");
  });

  test("onSubscribe is not called when adding second subscriber to same session", () => {
    const onSubscribe = vi.fn();
    const manager = createNodeSubscriptionManager({ onSubscribe });

    manager.subscribe("node-a", "session-1");
    manager.subscribe("node-b", "session-1");

    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(onSubscribe).toHaveBeenCalledWith("node-a", "session-1");
  });

  test("onSubscribe is called when re-subscribing after unsubscribeAll", () => {
    const onSubscribe = vi.fn();
    const manager = createNodeSubscriptionManager({ onSubscribe });

    manager.subscribe("node-a", "session-1");
    manager.unsubscribeAll("node-a");
    manager.subscribe("node-a", "session-1");

    expect(onSubscribe).toHaveBeenCalledTimes(2);
    expect(onSubscribe).toHaveBeenNthCalledWith(1, "node-a", "session-1");
    expect(onSubscribe).toHaveBeenNthCalledWith(2, "node-a", "session-1");
  });
});
