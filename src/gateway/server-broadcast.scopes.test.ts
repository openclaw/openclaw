import { describe, expect, it } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

describe("read-capable operator event scope guards", () => {
  it.each(["skills.changed", "users.prefs.changed", "plugins.changed"] as const)(
    "delivers %s only to read-capable operators",
    (event) => {
      const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
      const node = makeClient("node", "node", ["operator.read"]);
      const read = makeClient("read", "operator", ["operator.read"]);
      const write = makeClient("write", "operator", ["operator.write"]);
      const admin = makeClient("admin", "operator", ["operator.admin"]);
      const clients = new GatewayClientRegistry(
        [pairing, node, read, write, admin].map((entry) => entry.client),
      );
      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast(
        event,
        event === "users.prefs.changed"
          ? { profileId: "profile-1", keys: ["ui.accent"] }
          : event === "plugins.changed"
            ? { generation: 1 }
            : { reason: "remote-node" },
      );

      expect(pairing.socket.events).toEqual([]);
      expect(node.socket.events).toEqual([]);
      expect(read.socket.events).toEqual([event]);
      expect(write.socket.events).toEqual([event]);
      expect(admin.socket.events).toEqual([event]);
    },
  );
});

describe("Talk voice event scope guards", () => {
  it.each(["requested", "cancelled"])(
    "delivers a %s voice change only to targeted Talk-capable operators",
    (phase) => {
      const owner = makeClient("owner", "operator", ["operator.talk"]);
      const writer = makeClient("writer", "operator", ["operator.write"]);
      const admin = makeClient("admin", "operator", ["operator.admin"]);
      const observer = makeClient("observer", "operator", ["operator.talk"]);
      const reader = makeClient("reader", "operator", ["operator.read"]);
      const node = makeClient("node", "node", ["operator.talk"]);
      const targets = [owner, writer, admin, reader, node];
      const { broadcastToConnIds } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([...targets, observer].map((entry) => entry.client)),
      });

      broadcastToConnIds(
        "talk.voice.change",
        {
          phase,
          changeId: "change-1",
          voiceSessionId: "voice-1",
          sessionKey: "main",
          voice: "ember",
        },
        new Set(targets.map((entry) => entry.client.connId)),
      );

      for (const allowed of [owner, writer, admin]) {
        expect(allowed.socket.events).toEqual(["talk.voice.change"]);
      }
      for (const denied of [observer, reader, node]) {
        expect(denied.socket.events).toEqual([]);
      }
    },
  );
});

describe("update run event scope guards", () => {
  it("delivers run identities only to administrators", () => {
    const read = makeClient("read", "operator", ["operator.read"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const node = makeClient("node", "node", ["operator.admin"]);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([read.client, admin.client, node.client]),
    });
    broadcast("update.run.changed", {
      runId: "run",
      phase: "staging",
      status: "running",
      updatedAtMs: 1,
    });
    expect(read.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(admin.socket.events).toEqual(["update.run.changed"]);
  });
});

describe("plugin install progress scope guards", () => {
  it("delivers progress only to targeted administrators", () => {
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const observer = makeClient("observer", "operator", ["operator.admin"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const session = makeClient("session", "operator", [
      "operator.sessions.read",
      "operator.sessions.write",
    ]);
    const node = makeClient("node", "node", ["operator.admin"]);
    const targets = [admin, read, write, session, node];
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([...targets, observer].map((entry) => entry.client)),
    });
    const payload = { activityId: "install-activity", stage: "runtime", status: "started" };

    broadcastToConnIds(
      "plugins.install.progress",
      { ...payload, requestId: "install-request" },
      new Set(targets.map((entry) => entry.client.connId)),
    );

    expect(admin.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(admin.socket.send.mock.calls[0]![0] as string)).toEqual({
      type: "event",
      event: "plugins.install.progress",
      seq: 1,
      payload: { ...payload, requestId: "install-request" },
    });
    for (const denied of [observer, read, write, session, node]) {
      expect(denied.socket.send).not.toHaveBeenCalled();
    }
  });
});

describe("device setup event scope guards", () => {
  it("delivers exact setup completion only to pairing-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new GatewayClientRegistry(
      [pairing, node, read, admin].map((entry) => entry.client),
    );
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("device.pair.setup.completed", {
      setupId: "setup-123",
      deviceId: "device-123",
      access: "limited",
      ts: 1,
    });

    expect(pairing.socket.events).toEqual(["device.pair.setup.completed"]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual([]);
    expect(admin.socket.events).toEqual(["device.pair.setup.completed"]);
  });
});
