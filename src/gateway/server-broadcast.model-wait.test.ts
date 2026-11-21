import { expect, it } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

it.each([false, true])(
  "sends model-wait status only to capable clients (targeted=%s)",
  (targeted) => {
    const legacy = makeClient("legacy", "operator", ["operator.read"]);
    const current = makeClient("current", "operator", ["operator.read"]);
    current.client.connect.caps = ["model-wait-status"];
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([legacy.client, current.client]),
    });
    const publish = (payload: unknown) => {
      if (targeted) {
        broadcaster.broadcastToConnIds("chat", payload, new Set(["legacy", "current"]));
      } else {
        broadcaster.broadcast("chat", payload);
      }
    };
    const status = { runId: "run", sessionKey: "agent:main:wait", state: "status" };
    publish({ ...status, phase: "waiting_for_model", waitReason: "response" });
    expect(legacy.socket.send).not.toHaveBeenCalled();
    expect(current.socket.send).toHaveBeenCalledOnce();
    expect(current.socket.send.mock.calls.map(([raw]) => JSON.parse(raw).payload)).toEqual([
      { ...status, phase: "waiting_for_model", waitReason: "response" },
    ]);

    publish({ ...status, phase: "starting_model" });
    publish({ ...status, state: "aborted" });
    expect(legacy.socket.send).toHaveBeenCalledTimes(2);
    expect(current.socket.send).toHaveBeenCalledTimes(3);
  },
);
