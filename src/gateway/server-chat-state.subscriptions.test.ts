import { describe, expect, it, vi } from "vitest";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";

const key = "agent:main:global";

describe("session message subscription owners", () => {
  it("aggregates full streams and approvals while releasing only the named observer", () => {
    const registry = createSessionMessageSubscriberRegistry();
    const changes = vi.fn(() => ({
      subscribed: registry.get(key).has("conn"),
      narration: registry.getNarration(key).has("conn"),
      approvals: registry.getApprovals(key).has("conn"),
    }));
    registry.onChange(changes);
    registry.subscribe("conn", key, { subscriptionId: "foreground" });
    registry.subscribe("conn", key, {
      subscriptionId: "sidebar",
      mode: "narration",
      includeApprovals: true,
    });
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual(["conn"]);

    registry.unsubscribe("conn", key, "foreground");
    expect(changes.mock.results.at(-1)?.value).toEqual({
      subscribed: true,
      narration: true,
      approvals: true,
    });
    registry.subscribe("conn", key);
    expect([...registry.getNarration(key)]).toEqual([]);
    registry.unsubscribe("conn", key);
    expect([...registry.getNarration(key)]).toEqual(["conn"]);
    registry.unsubscribe("conn", key, "unknown");
    expect([...registry.get(key)]).toEqual(["conn"]);

    registry.unsubscribe("conn", key, "sidebar");
    expect(changes.mock.results.at(-1)?.value).toEqual({
      subscribed: false,
      narration: false,
      approvals: false,
    });
  });

  it("keeps a provisional foreground owner through another owner's failed replay", () => {
    const registry = createSessionMessageSubscriberRegistry();
    registry.subscribe("conn", key, { subscriptionId: "sidebar", mode: "narration" });
    const foreground = registry.subscribe("conn", key, {
      subscriptionId: "foreground",
      provisional: true,
      includeApprovals: true,
    })!;
    const narration = registry.subscribe("conn", key, {
      subscriptionId: "sidebar",
      provisional: true,
      mode: "narration",
    })!;
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual(["conn"]);

    narration();
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual(["conn"]);
    foreground();
    expect([...registry.getNarration(key)]).toEqual(["conn"]);
    expect([...registry.getApprovals(key)]).toEqual([]);
  });

  it.each([false, true])(
    "retains full delivery until an older in-flight intent settles (succeeds=%s)",
    (succeeds) => {
      const registry = createSessionMessageSubscriberRegistry();
      const foreground = registry.subscribe("conn", key, {
        subscriptionId: "owner",
        provisional: true,
      })!;
      const narration = registry.subscribe("conn", key, {
        subscriptionId: "owner",
        provisional: true,
        mode: "narration",
      })!;
      narration.commit();
      expect([...registry.getNarration(key)]).toEqual([]);

      if (succeeds) {
        foreground.commit();
      } else {
        foreground();
      }
      expect([...registry.getNarration(key)]).toEqual(["conn"]);
    },
  );

  it.each(["unsubscribe", "disconnect"])(
    "fences pending owner settlements after %s and ID reuse",
    (action) => {
      const registry = createSessionMessageSubscriberRegistry();
      const old = registry.subscribe("conn", key, {
        subscriptionId: "owner",
        provisional: true,
        includeApprovals: true,
      })!;
      if (action === "disconnect") {
        registry.unsubscribeAll("conn");
      } else {
        registry.unsubscribe("conn", key, "owner");
      }
      registry.subscribe("conn", key, { subscriptionId: "owner", mode: "narration" });
      old.commit();
      expect([...registry.getNarration(key)]).toEqual(["conn"]);
      expect([...registry.getApprovals(key)]).toEqual([]);
      registry.subscribe("conn", key, { subscriptionId: "another" });
      registry.unsubscribeAll("conn");
      expect([...registry.get(key)]).toEqual([]);
      expect([...registry.getNarration(key)]).toEqual([]);
      expect([...registry.getApprovals(key)]).toEqual([]);
    },
  );
});
