import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildActiveNodeContextText,
  getCurrentActiveNodeContext,
  setActiveNodeContexts,
} from "../infra/active-node-context.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

const registries = new Set<NodeRegistry>();
function createNodeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registries.add(registry);
  return registry;
}
afterEach(() => {
  for (const registry of registries) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
    }
  }
  registries.clear();
  setActiveNodeContexts([]);
});

describe("node registry presence", () => {
  it("ranks connected nodes by gateway-derived input activity", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        displayName: "Desk Mac",
        permissions: { accessibility: true },
      }),
      {},
    );
    registerNodeSession(
      registry,
      makeClient("conn-2", "node-2", [], {
        displayName: "Laptop",
        permissions: { accessibility: true },
      }),
      {},
    );

    expect(
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-1",
        idleSeconds: 10,
        observedAtMs: 100_000,
      }),
    ).toMatchObject({ lastActiveAtMs: 90_000, presenceUpdatedAtMs: 100_000 });
    registry.updatePresenceActivity({
      nodeId: "node-2",
      connId: "conn-2",
      idleSeconds: 2,
      observedAtMs: 105_000,
    });

    expect(registry.getActiveNode()?.nodeId).toBe("node-2");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-2" });
    expect(registry.unregister("conn-2")).toBe("node-2");
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-1" });
  });

  it("recomputes active context when a same-id connection replaces reported presence", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-old", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-old",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
    expect(registry.unregister("conn-old")).toBeNull();
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("keeps requester presence separate from other people and shared computers", () => {
    const registry = createNodeRegistry();
    for (const [nodeId, profileId, idleSeconds] of [
      ["alice-mac", "alice", 10],
      ["alice-laptop", "alice", 5],
      ["bob-mac", "bob", 1],
      ["shared-mac", "gateway-owner", 0],
    ] as const) {
      const client = makeClient(nodeId, nodeId, []);
      client.authenticatedUserProfile = {
        profileId,
        displayName: profileId,
        avatarRevision: "0",
        hasAvatar: false,
        updatedAt: 0,
      };
      registerNodeSession(registry, client, {});
      registry.updatePresenceActivity({
        nodeId,
        connId: nodeId,
        idleSeconds,
        source: "app",
        observedAtMs: 100_000,
      });
    }

    expect(registry.getActiveNode()?.nodeId).toBe("shared-mac");
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("alice-laptop");
    expect(getCurrentActiveNodeContext("bob")?.nodeId).toBe("bob-mac");
    expect(getCurrentActiveNodeContext("absent-person")).toBeNull();
    expect(buildActiveNodeContextText("alice")).toContain(
      "active_node=alice-laptop active_node_identity=requester",
    );
    expect(buildActiveNodeContextText("gateway-owner")).toContain(
      "active_node=shared-mac active_node_identity=unknown",
    );
    expect(getCurrentActiveNodeContext()?.nodeId).toBe("shared-mac");

    registry.unregister("alice-laptop");
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("alice-mac");
    registry.unregister("alice-mac");
    expect(getCurrentActiveNodeContext("alice")).toBeNull();
    expect(getCurrentActiveNodeContext("bob")?.nodeId).toBe("bob-mac");

    const profile = expectDefined(
      registry.get("bob-mac")?.client.authenticatedUserProfile,
      "Bob's authenticated profile",
    );
    profile.profileId = "alice";
    expect(getCurrentActiveNodeContext("bob")).toBeNull();
    expect(getCurrentActiveNodeContext("alice")).toBeNull();
    registry.updatePresenceActivity({
      nodeId: "bob-mac",
      connId: "bob-mac",
      idleSeconds: 0,
      source: "app",
      observedAtMs: 110_000,
    });
    expect(getCurrentActiveNodeContext("bob")).toBeNull();
    expect(getCurrentActiveNodeContext("alice")?.nodeId).toBe("bob-mac");
  });

  it("rejects presence updates from stale node connections", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-new", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );

    expect(
      registry.updatePresenceActivity({
        nodeId: "node-1",
        connId: "conn-old",
        idleSeconds: 0,
        observedAtMs: 100_000,
      }),
    ).toBeNull();
    expect(registry.getActiveNode()).toBeUndefined();
  });

  it("does not advance a bounded estimate on saturated idle keepalives", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    const first = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_000_000,
    });
    const keepalive = registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 2_592_000,
      saturated: true,
      observedAtMs: 3_000_180_000,
    });

    expect(first?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.lastActiveAtMs).toBe(408_000_000);
    expect(keepalive?.presenceUpdatedAtMs).toBe(3_000_180_000);
  });

  it("clears reported presence when Accessibility permission is removed", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], {
        permissions: { accessibility: true },
        declaredPermissions: { accessibility: true },
      }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 0,
      observedAtMs: 100_000,
    });

    registry.updateSurface("node-1", { commands: [], permissions: { accessibility: false } });

    expect(registry.get("node-1")?.lastActiveAtMs).toBeUndefined();
    expect(registry.get("node-1")?.presenceUpdatedAtMs).toBeUndefined();
    expect(registry.getActiveNode()).toBeUndefined();
    expect(getCurrentActiveNodeContext()).toBeNull();
  });

  it("clears presence only for the current connection and selects the next active Mac", () => {
    const registry = createNodeRegistry();
    registerNodeSession(
      registry,
      makeClient("conn-1", "node-1", [], { permissions: { accessibility: true } }),
      {},
    );
    registerNodeSession(
      registry,
      makeClient("conn-2", "node-2", [], { permissions: { accessibility: true } }),
      {},
    );
    registry.updatePresenceActivity({
      nodeId: "node-1",
      connId: "conn-1",
      idleSeconds: 10,
      observedAtMs: 100_000,
    });
    registry.updatePresenceActivity({
      nodeId: "node-2",
      connId: "conn-2",
      idleSeconds: 0,
      observedAtMs: 105_000,
    });

    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-old" })).toBeNull();
    expect(registry.getActiveNode()?.nodeId).toBe("node-2");
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(true);
    expect(registry.getActiveNode()?.nodeId).toBe("node-1");
    expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "node-1" });
    expect(registry.clearPresenceActivity({ nodeId: "node-2", connId: "conn-2" })).toBe(false);
  });
});
