/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { challengeConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { wsInstances } from "./gateway-socket.test-support.ts";

const createClient = useHandshakeHarness(webcrypto);

it("does not publish the bootstrap hello before the paired device connects", async () => {
  const key = Buffer.alloc(32).toString("base64url");
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "device-1",
    privateKey: key,
    publicKey: key,
  });
  vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("signature");
  const url = "ws://127.0.0.1:18789";
  nodes.storeDeviceAuthToken({
    deviceId: "device-1",
    gatewayUrl: url,
    role: "operator",
    token: "stored-device-token",
    scopes: ["operator.admin"],
  });
  const onHello = vi.fn();
  const client = createClient({ url, bootstrapToken: "handoff", token: "old-secret", onHello });
  const auth = {
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    deviceToken: "paired-device",
  };
  async function accept(
    connection: Awaited<ReturnType<typeof challengeConnect>>,
    method: "bootstrap-token" | "device-token",
  ) {
    connection.ws.emitMessage({
      type: "res",
      id: connection.connectFrame.id,
      ok: true,
      payload: { type: "hello-ok", protocol: PROTOCOL_VERSION, auth: { ...auth, method } },
    });
    await vi.advanceTimersByTimeAsync(0);
  }

  client.start();
  const first = await challengeConnect("first-challenge");
  expect(first.connectFrame.params.auth).toEqual({ bootstrapToken: "handoff" });
  await accept(first, "bootstrap-token");
  expect(onHello).not.toHaveBeenCalled();

  const paired = await challengeConnect("paired-challenge");
  expect(paired.connectFrame.params.auth).toEqual({ deviceToken: auth.deviceToken });
  expect(paired.connectFrame.params.scopes).toEqual(auth.scopes);
  await accept(paired, "device-token");
  expect(onHello).toHaveBeenCalledOnce();
  expect(wsInstances).toHaveLength(2);
});
