// Who may read people (OCF-318): openclawId.status is the same small summary for
// every client, and openclawId.people answers only the direct-loopback operator
// and a tunnel client whose device key is an active owner device right now.
// Members (viewer or operator), expired owners and LAN clients are refused even
// though they reach the method.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-method-policy.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { linkedClaw, nowSeconds, serviceFor, type LinkedClaw } from "./openclaw-id.test-support.js";
import type { OpenClawIdService } from "./service.js";

type Response = {
  ok: boolean;
  payload?: Record<string, unknown> & { link?: Record<string, unknown> };
  error?: { details?: { code?: string } };
};

// A client as the connection handshake records it: direct loopback, relayed by
// the tunnel with its device key, or anything else (LAN, proxied).
const loopback = { internal: { isLocalClient: true } };
const tunnel = (peerKey: string) => ({
  internal: { isLocalClient: true, openclawIdPeerKey: peerKey },
});
const lan = { internal: {} };

// Calls an openclawId.* handler as `client`.
async function call(
  service: OpenClawIdService,
  method: "openclawId.status" | "openclawId.people",
  client: unknown,
): Promise<Response> {
  let response: Response | undefined;
  await openclawIdHandlers[method]!({
    params: {},
    client,
    respond: (ok: boolean, payload?: Response["payload"], error?: Response["error"]) => {
      response = { ok, payload, error };
    },
    context: { openclawIdService: service, getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions);
  return response!;
}

// Adds a member with one tunnel key, as an approved invite would.
async function addMember(claw: LinkedClaw, accountId: string, role: "operator" | "viewer") {
  const peerKey = formatIrohEndpointKey(randomBytes(32));
  const add = await claw.sign({
    op: "add",
    account_id: accountId,
    role,
    peer_keys: [peerKey],
    invite_id: null,
  });
  expect(await claw.authority.submit(add, "tunnel")).toMatchObject({ ok: true });
  return peerKey;
}

// Enrolls a second owner device whose certificate expires in `seconds`.
async function addExpiringOwner(claw: LinkedClaw, seconds: number) {
  const device = await generateEd25519Signer();
  const peerKey = formatIrohEndpointKey(randomBytes(32));
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [peerKey],
      label: "borrowed laptop",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: nowSeconds() + seconds,
      root_epoch: 1,
    },
    claw.device,
    [claw.cert],
  );
  const change = await claw.sign({ op: "add_owner_device", cert });
  expect(await claw.authority.submit(change, "tunnel")).toMatchObject({ ok: true });
  return peerKey;
}

const SUMMARY_KEYS = ["clawId", "frozen", "hostname", "linked", "rootEpoch", "rootPub"];

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenClaw ID people access", () => {
  it("needs the admin scope as well as an owner", () => {
    expect(resolveCoreOperatorGatewayMethodScope("openclawId.people")).toBe("operator.admin");
    expect(resolveCoreOperatorGatewayMethodScope("openclawId.status")).toBe("operator.read");
  });

  it("gives a viewer and an operator member only the summary and refuses them people", async () => {
    const claw = await linkedClaw();
    const viewer = await addMember(claw, "acct-viewer", "viewer");
    const operator = await addMember(claw, "acct-operator", "operator");
    const { service } = serviceFor(claw.authority);
    for (const key of [viewer, operator]) {
      const status = await call(service, "openclawId.status", tunnel(key));
      expect(status.ok).toBe(true);
      expect(status.payload?.owner).toBe(false);
      expect(Object.keys(status.payload!.link!).toSorted()).toEqual(SUMMARY_KEYS);
      expect(JSON.stringify(status.payload)).not.toMatch(/acct-|sessionKey|runId|lastSeenAt/);
      const people = await call(service, "openclawId.people", tunnel(key));
      expect(people).toMatchObject({ ok: false, error: { details: { code: "not_owner" } } });
    }
  });

  it("answers an owner device over the tunnel with members and their activity", async () => {
    const claw = await linkedClaw();
    await addMember(claw, "acct-operator", "operator");
    const { service } = serviceFor(claw.authority);
    const status = await call(service, "openclawId.status", tunnel(claw.w1));
    expect(status.payload?.owner).toBe(true);
    expect(Object.keys(status.payload!.link!).toSorted()).toEqual(SUMMARY_KEYS);
    const people = await call(service, "openclawId.people", tunnel(claw.w1));
    expect(people.ok).toBe(true);
    expect(people.payload?.link).toMatchObject({
      members: [
        {
          accountId: "acct-operator",
          devices: [expect.objectContaining({ runs: [{ runId: "r1", sessionKey: "s1" }] })],
        },
      ],
      ownerDevices: [expect.objectContaining({ label: "phone" })],
    });
  });

  it("answers the direct-loopback operator and refuses a LAN client", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    expect((await call(service, "openclawId.people", loopback)).ok).toBe(true);
    expect((await call(service, "openclawId.status", lan)).payload?.owner).toBe(false);
    expect(await call(service, "openclawId.people", lan)).toMatchObject({
      ok: false,
      error: { details: { code: "not_owner" } },
    });
  });

  it("refuses an owner device once its certificate has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 31, 12) });
    const claw = await linkedClaw();
    const expiring = await addExpiringOwner(claw, 60);
    const { service } = serviceFor(claw.authority);
    expect((await call(service, "openclawId.people", tunnel(expiring))).ok).toBe(true);
    vi.setSystemTime(Date.UTC(2026, 9, 31, 12, 1));
    expect((await call(service, "openclawId.status", tunnel(expiring))).payload?.owner).toBe(false);
    expect(await call(service, "openclawId.people", tunnel(expiring))).toMatchObject({
      ok: false,
      error: { details: { code: "not_owner" } },
    });
    expect((await call(service, "openclawId.people", tunnel(claw.w1))).ok).toBe(true);
  });
});
