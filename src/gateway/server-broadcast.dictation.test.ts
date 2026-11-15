import { expect, it } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

it("delivers guest transcription only to its targeted, currently readable session", () => {
  const { client, socket } = makeClient("dictation", "operator", ["operator.sessions.write"]);
  let allowed = true;
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
    clients: new GatewayClientRegistry([client]),
    canReceiveSessionEvent: (_client, keys) =>
      allowed && keys.every((key) => key === "agent:main:own"),
  });
  const target = new Set([client.connId!]);
  const transcript = { transcriptionSessionId: "recording", type: "transcript", text: "dictation" };
  const own = { sessionKeys: ["agent:main:own"] };
  broadcastToConnIds("talk.event", transcript, target, own);
  expect(socket.send).toHaveBeenCalledTimes(1);

  broadcast("talk.event", transcript, own);
  broadcastToConnIds("talk.event", { type: "transcript", text: "other Talk" }, target, own);
  broadcastToConnIds("talk.event", transcript, target, { sessionKeys: ["agent:main:foreign"] });
  broadcastToConnIds("talk.event", transcript, target);
  allowed = false;
  broadcastToConnIds("talk.event", transcript, target, own);
  expect(socket.send).toHaveBeenCalledTimes(1);
});
