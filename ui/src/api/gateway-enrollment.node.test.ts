/** @vitest-environment node */
import { webcrypto } from "node:crypto";
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { registerProfileEnglish } from "../i18n/locales/en-profile.ts";
import * as nodes from "../lib/nodes/index.ts";
import { PersonalEnrollmentState } from "../pages/profile/personal-enrollment-state.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { startConnect, useHandshakeHarness } from "./gateway-handshake.test-support.ts";
import { enrollGatewayProfile } from "./gateway-profile-enrollment.ts";

const createClient = useHandshakeHarness(webcrypto);
beforeEach(() => {
  registerProfileEnglish();
  vi.spyOn(nodes, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "signed-device",
    privateKey: "AA",
    publicKey: "AA",
  });
  vi.spyOn(nodes, "signDevicePayload").mockResolvedValue("signature");
});

async function connectOperator(scopes = ["operator.admin"]) {
  const client = createClient();
  const { ws, connectFrame } = await startConnect(client);
  ws.emitMessage({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: { type: "hello-ok", protocol: PROTOCOL_VERSION, auth: { role: "operator", scopes } },
  });
  await vi.advanceTimersByTimeAsync(0);
  return { client, ws };
}

it("finishes personal credential reconnect when the enrollment form was dismissed", async () => {
  const { client, ws } = await connectOperator();
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({ client, phase: "connected", hello: client.hello }),
  );
  const state = new PersonalEnrollmentState(gateway, () => undefined);
  const connect = vi.spyOn(gateway, "connect");
  const pending = state.enroll();
  const frame = JSON.parse(ws.sent.at(-1)!);
  state.dispose();
  ws.emitMessage({
    type: "res",
    id: frame.id,
    ok: true,
    payload: {
      deviceId: "signed-device",
      profileId: "person",
      operatorToken: { token: "dismissed-person-token", scopes: ["operator.read"] },
    },
  });
  await pending;
  expect(connect).toHaveBeenCalledWith({ token: "", password: "", bootstrapToken: "" });
  expect(
    nodes.loadDeviceAuthToken({
      deviceId: "signed-device",
      gatewayUrl: client.gatewayUrl,
      role: "operator",
    }),
  ).toMatchObject({ token: "dismissed-person-token" });
});

it("does not persist a returned token after its connection authority retires", async () => {
  const { client, ws } = await connectOperator();
  const pending = enrollGatewayProfile(client, { profileId: "person" });
  const rejected = expect(pending).rejects.toThrow();
  client.stop();
  await rejected;
  const dispatched = ws.sent.length;
  await expect(enrollGatewayProfile(client, { profileId: "person" })).rejects.toThrow(
    "Personal setup requires a connected operator device",
  );
  expect(ws.sent).toHaveLength(dispatched);
  expect(
    nodes.loadDeviceAuthToken({
      deviceId: "signed-device",
      gatewayUrl: client.gatewayUrl,
      role: "operator",
    }),
  ).toBeNull();
});

it("keeps self enrollment pending until replacement admission confirms the returned person", async () => {
  const { client, ws } = await connectOperator();
  const original = createApplicationGatewaySnapshot({
    client,
    phase: "connected",
    hello: client.hello,
    selfUser: { id: "gateway-owner" },
  });
  const { gateway, publish } = createApplicationGateway(original);
  // Devices can target this device too; the returned device, not the entry point, decides self.
  const state = new PersonalEnrollmentState(gateway, () => undefined, "signed-device");
  const stop = gateway.subscribe(() => state.sync());
  const connect = vi.spyOn(gateway, "connect");
  try {
    const pending = state.enroll();
    const request = JSON.parse(ws.sent.at(-1)!);
    ws.emitMessage({
      type: "res",
      id: request.id,
      ok: true,
      payload: {
        deviceId: "signed-device",
        profileId: "expected-person",
        operatorToken: { token: "new-person-token", scopes: ["operator.read"] },
      },
    });
    await pending;
    expect(connect).toHaveBeenCalledOnce();
    expect(state).toMatchObject({
      success: false,
      busy: true,
      expectedProfileId: "expected-person",
      reconnecting: true,
      error: null,
    });
    expect(
      nodes.loadDeviceAuthToken({
        deviceId: "signed-device",
        gatewayUrl: client.gatewayUrl,
        role: "operator",
      })?.token,
    ).toBe("new-person-token");
    publish({ ...original, selfUser: { id: "expected-person" } });
    expect(state.success).toBe(false);
    publish({ ...gateway.snapshot, phase: "reconnecting", selfUser: undefined });
    expect(state).toMatchObject({ success: false, busy: true, reconnecting: true, error: null });
    publish({
      ...gateway.snapshot,
      phase: "offline",
      lastErrorCode: "FORBIDDEN",
      lastError: "Synthetic replacement admission denied",
    });
    expect(state).toMatchObject({ success: false, busy: false, reconnecting: false });
    expect(state.error).toContain("approved owner or admin");

    const { client: nextClient } = await connectOperator(["operator.read"]);
    publish({ ...original, client: nextClient, hello: nextClient.hello, selfUser: undefined });
    expect(state).toMatchObject({ success: false, busy: true, reconnecting: true, error: null });
    publish({ ...gateway.snapshot, selfUser: { id: "another-person" } });
    expect(state.success).toBe(false);
    expect(state.error).toContain("device or person changed");
    publish({ ...gateway.snapshot, selfUser: { id: "expected-person" } });
    expect(state).toMatchObject({ success: true, busy: false, reconnecting: false, error: null });
  } finally {
    stop();
    state.dispose();
  }
});
