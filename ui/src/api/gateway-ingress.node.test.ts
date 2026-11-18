/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as nodes from "../lib/nodes/index.ts";
import { startConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { expectSignedPayloadFields } from "./gateway-signature.test-support.ts";

const gatewayUrl = "ws://127.0.0.1:18789";
const createClient = useHandshakeHarness(webcrypto);

it("signs credential-free ingress connects and reconnects without reading or storing device tokens", async () => {
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (name: string) => (name === "data-openclaw-remote-ingress" ? "true" : null),
    },
  });
  nodes.storeDeviceAuthToken({
    deviceId: "device-1",
    role: "operator",
    gatewayUrl,
    token: "previous-browser-token",
    scopes: ["operator.admin"],
  });
  const loadToken = vi.spyOn(nodes, "loadDeviceAuthToken");
  const storeToken = vi.spyOn(nodes, "storeDeviceAuthToken");
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "device-1",
    publicKey: "synthetic-public-key",
    privateKey: "synthetic-private-key",
  });
  const sign = vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("synthetic-signature");
  const onReconnectScheduled = vi.fn<(delayMs: number) => void>();
  const nativeConnectAuth = vi.fn();
  const client = createClient({
    url: gatewayUrl,
    token: "synthetic-shared-token",
    password: "synthetic-password",
    bootstrapToken: "synthetic-bootstrap-token",
    nativeConnectAuth,
    onReconnectScheduled,
  });
  const first = await startConnect(client, "synthetic-nonce");
  expect(first.connectFrame.params.auth).toBeUndefined();
  expect(first.connectFrame.params).toMatchObject({
    role: "operator",
    scopes: [],
    device: { id: "device-1", signature: "synthetic-signature" },
  });
  expectSignedPayloadFields(sign.mock.calls[0]?.[1], {
    scopes: [],
    token: "",
    nonce: "synthetic-nonce",
    signedAtMs: 1_800_000_000_000,
  });
  expect(loadToken).not.toHaveBeenCalled();
  expect(nativeConnectAuth).not.toHaveBeenCalled();
  first.ws.emitMessage({
    type: "res",
    id: first.connectFrame.id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      auth: {
        role: "operator",
        // Even an unexpected token must not create reusable ingress credentials.
        deviceToken: "ignored-ingress-token",
        scopes: ["operator.admin"],
        recoveryScope: "grant-principal-recovery",
      },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(client).toMatchObject({
    connected: true,
    scopeUpgradeReady: false,
    recoveryScope: "grant-principal-recovery",
  });
  expect(storeToken).not.toHaveBeenCalled();

  first.ws.emitClose(1006, "transport interrupted");
  expect(onReconnectScheduled).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(onReconnectScheduled.mock.calls[0]![0]);
  const next = await startConnect(client, "synthetic-nonce");
  expect(next.connectFrame.params.auth).toBeUndefined();
  expect(next.connectFrame.params).toMatchObject({ scopes: [], device: { id: "device-1" } });
  expect(loadToken).not.toHaveBeenCalled();
  expect(storeToken).not.toHaveBeenCalled();
});
