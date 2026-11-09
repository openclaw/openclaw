import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  bytesToBase64url,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import {
  linkedClaw,
  nowSeconds,
  ownerInvite,
  serviceFor,
  type LinkedClaw,
} from "./openclaw-id.test-support.js";

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

// Serves the tunnel API the way the ingress listener does; the test names the
// authenticated peer key in a header the real listener would take from QUIC.
async function tunnelApi(claw: LinkedClaw) {
  const { service, log } = serviceFor(claw.authority);
  server = http.createServer((req, res) => {
    void service.serveTunnelApi(req, res, String(req.headers["x-test-peer"]));
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const call = async (peer: string, method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/_openclaw-id/v1/${route}`, {
      method,
      headers: { "x-test-peer": peer, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { call, service, log };
}

// What an approving owner device E does in SAS step 7: certify N with D_E
// (E is listed at the claw) and sign add_owner_device.
async function sasApproval(claw: LinkedClaw) {
  const newDevice = await generateEd25519Signer();
  const newPeer = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(newDevice.publicKey),
      peer_keys: [newPeer],
      label: "Firefox on Linux",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: 1,
    },
    claw.device,
  );
  return { cert, newPeer, change: await claw.sign({ op: "add_owner_device", cert }) };
}

describe("OpenClaw ID tunnel API", () => {
  it("gives an owner device the seq, binding and active owner devices with their approvers", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const { status, body } = await call(claw.w1, "GET", "membership");
    expect(status).toBe(200);
    expect(body).toMatchObject({ claw_id: claw.clawId, seq: 1 });
    expect(body).not.toHaveProperty("root_epoch");
    expect(body.binding.type).toBe("ServerBinding");
    expect(body.owner_devices).toEqual([
      { cert: claw.cert, caps: claw.cert.body.caps, approved_by: "root" },
    ]);
  });

  it("does not show membership to a device that is not an owner device", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const member = formatIrohEndpointKey(randomBytes(32));
    expect(await call(member, "GET", "membership")).toMatchObject({
      status: 403,
      body: { error: { code: "not_owner_device" } },
    });
  });

  // Spec 6.1 step 7 ("admit first"): E admits N directly before sealing the hand-off.
  it("admits a SAS-approved owner device sent directly over the tunnel", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const { change, newPeer, cert } = await sasApproval(claw);
    expect(await call(claw.w1, "POST", "statements", { statement: change })).toEqual({
      status: 200,
      body: { status: "applied", seq: 2 },
    });
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(newPeer);
    // N is now an owner device too and can read membership over its own tunnel.
    const view = await call(newPeer, "GET", "membership");
    expect(view.body.owner_devices).toEqual(
      expect.arrayContaining([
        { cert: claw.cert, caps: claw.cert.body.caps, approved_by: "root" },
        { cert, caps: cert.body.caps, approved_by: expect.stringMatching(/^fp:/) },
      ]),
    );
  });

  it("refuses a replayed approval with seq_conflict", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const { change } = await sasApproval(claw);
    await call(claw.w1, "POST", "statements", { statement: change });
    expect(await call(claw.w1, "POST", "statements", { statement: change })).toMatchObject({
      status: 409,
      body: { error: { code: "seq_conflict" } },
    });
  });

  it("refuses a statement whose signature does not verify", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const { change } = await sasApproval(claw);
    const forged = { ...change, sig: bytesToBase64url(randomBytes(64)) };
    const result = await call(claw.w1, "POST", "statements", { statement: forged });
    expect(result.status).toBe(403);
    expect((await claw.authority.load())?.authority?.seq).toBe(1);
  });

  it.each([
    ["no statement", "statements", {}],
    ["a short proof key", "invites", { cap: {}, proof_key: "AAAA" }],
  ])("answers %s with malformed", async (_label, route, body) => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    expect(await call(claw.w1, "POST", route, body)).toMatchObject({
      status: 400,
      body: { error: { code: "malformed" } },
    });
  });

  it("only allows the method each endpoint uses", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    expect((await call(claw.w1, "POST", "membership", {})).status).toBe(405);
    expect((await call(claw.w1, "GET", "statements")).status).toBe(405);
    expect((await call(claw.w1, "GET", "nothing-here")).status).toBe(404);
  });

  it("registers an invite from an owner device and lists it to owners", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const invite = await ownerInvite(claw, { email: "bob@example.com", role: "viewer" });
    expect(
      await call(claw.w1, "POST", "invites", {
        cap: invite.cap,
        proof_key: bytesToBase64url(invite.proofKey),
      }),
    ).toEqual({ status: 200, body: { status: "applied", seq: 1 } });
    const view = await call(claw.w1, "GET", "membership");
    expect(view.body.invites).toEqual([
      expect.objectContaining({ inviteId: invite.inviteId, status: "open", role: "viewer" }),
    ]);
  });

  // Spec 6.2: kit enrollment arrives by mailbox; certificates are not re-signed afterwards.
  it("accepts kit enrollment by mailbox and refuses a bare certificate over the tunnel", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const kitDevice = await generateEd25519Signer();
    const kitPeer = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
    const kitCert = await signStatement(
      "OwnerDeviceCert",
      {
        device_pub: formatEd25519PublicKey(kitDevice.publicKey),
        peer_keys: [kitPeer],
        label: "kit device",
        scope: "owner",
        caps: [...OWNER_CAPABILITIES],
        issued_at: nowSeconds(),
        expires_at: null,
        root_epoch: 1,
      },
      claw.root,
    );
    const enroll = await claw.sign({ op: "add_owner_device", cert: kitCert }, claw.root);
    const [result] = await applyMailboxMessage(
      {
        message_id: "kit",
        claw_id: claw.clawId,
        to: "gateway",
        from: {
          account_id: "acct-owner",
          email: null,
          display_name: null,
          device_fp: null,
          reported_by: "openclaw-id",
        },
        location_hint: null,
        payload: { kind: "root_statement", statements: [enroll] },
        received_at: nowSeconds(),
        expires_at: nowSeconds() + 60,
      },
      {
        submit: (statement) => claw.authority.submit(statement, "mailbox"),
        redeem: (redemption, sender) => claw.authority.redeem(redemption, sender),
        redeemNode: (redemption) => claw.authority.redeemNode(redemption),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      events: expect.arrayContaining([
        { type: "notify_owners", event: "kit_used", ref: expect.any(String) },
      ]),
    });
    const view = await call(kitPeer, "GET", "membership");
    expect(view.status).toBe(200);
    const recert = await signStatement(
      "OwnerDeviceCert",
      { ...claw.cert.body, issued_at: nowSeconds() },
      claw.root,
    );
    expect(await call(kitPeer, "POST", "statements", { statement: recert })).toMatchObject({
      body: { error: { code: "unsupported" } },
    });
  });
});
