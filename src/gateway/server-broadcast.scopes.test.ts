import { describe, expect, it } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

const readScopes = ["read", "write", "admin"];

describe("operator event scope guards", () => {
  it.each([
    { event: "skills.changed", payload: { reason: "remote-node" }, allowed: readScopes },
    {
      event: "users.prefs.changed",
      payload: { profileId: "profile-1", keys: ["ui.accent"] },
      allowed: readScopes,
    },
    { event: "plugins.changed", payload: { generation: 1 }, allowed: readScopes },
    { event: "mcp.app.resourceUpdated", payload: { reason: "remote-node" }, allowed: readScopes },
    {
      event: "mcp.app.hostContextChanged",
      payload: { reason: "remote-node" },
      allowed: readScopes,
    },
    {
      event: "talk.voice.change",
      payload: {
        phase: "requested",
        changeId: "change-1",
        voiceSessionId: "voice-1",
        sessionKey: "main",
        voice: "ember",
      },
      allowed: ["talk", "write", "admin"],
      targeted: true,
      nodeScope: "talk",
    },
    {
      event: "update.run.changed",
      payload: { runId: "run", phase: "staging", status: "running", updatedAtMs: 1 },
      allowed: ["admin"],
      nodeScope: "admin",
    },
    {
      event: "plugins.install.progress",
      payload: {
        activityId: "install-activity",
        stage: "runtime",
        status: "started",
        requestId: "install-request",
      },
      allowed: ["admin"],
      targeted: true,
      nodeScope: "admin",
    },
    {
      event: "device.pair.setup.completed",
      payload: { setupId: "setup-123", deviceId: "device-123", access: "limited", ts: 1 },
      allowed: ["pairing", "admin"],
    },
  ])(
    "delivers $event only to authorized recipients",
    ({ event, payload, allowed, targeted, nodeScope }) => {
      const operators = ["pairing", "read", "write", "admin", "talk"].map((scope) =>
        makeClient(scope, "operator", [`operator.${scope}`]),
      );
      const session = makeClient("session", "operator", [
        "operator.sessions.read",
        "operator.sessions.write",
      ]);
      const node = makeClient("node", "node", [`operator.${nodeScope ?? "read"}`]);
      const targets = [...operators, session, node];
      const observer = makeClient("observer", "operator", [`operator.${allowed[0]}`]);
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(
          (targeted ? [...targets, observer] : targets).map(({ client }) => client),
        ),
      });
      if (targeted) {
        broadcaster.broadcastToConnIds(
          event,
          payload,
          new Set(targets.map(({ client }) => client.connId)),
        );
        expect(observer.socket.send).not.toHaveBeenCalled();
      } else {
        broadcaster.broadcast(event, payload);
      }
      for (const { client, socket } of targets) {
        if (allowed.includes(client.connId)) {
          expect(socket.events).toEqual([event]);
          expect(socket.send).toHaveBeenCalledOnce();
          expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
            type: "event",
            event,
            seq: 1,
            payload,
          });
        } else {
          expect(socket.events).toEqual([]);
          expect(socket.send).not.toHaveBeenCalled();
        }
      }
    },
  );
});
