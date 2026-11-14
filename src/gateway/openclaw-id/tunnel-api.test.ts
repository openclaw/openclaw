import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bytesToBase64url,
  formatEd25519PublicKey,
  fingerprint,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import { MEMBER_ROLE_PRESETS } from "./member-role-presets.js";
import {
  linkedClaw,
  nowSeconds,
  ownerInvite,
  redemptionMail,
  serviceFor,
  type LinkedClaw,
} from "./openclaw-id.test-support.js";

let server: http.Server | undefined;

beforeEach(() =>
  setRuntimeConfigSnapshot({
    gateway: { roles: { definitions: MEMBER_ROLE_PRESETS } },
  }),
);
afterEach(() => {
  clearRuntimeConfigSnapshot();
  server?.close();
  server = undefined;
});

// Serves the tunnel API the way the ingress listener does; the test names the
// authenticated peer key in a header the real listener would take from QUIC.
async function tunnelApi(claw: LinkedClaw) {
  const { service, log, effects } = serviceFor(claw.authority);
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
  return { call, service, log, effects };
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

  it("shows only the caller account to an admitted member without signing metadata", async () => {
    const claw = await linkedClaw();
    const { call } = await tunnelApi(claw);
    const member = formatIrohEndpointKey(randomBytes(32));
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "acct-viewer",
          role: "viewer",
          peer_keys: [member],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    expect(await call(member, "GET", "membership")).toMatchObject({
      status: 200,
      body: {
        account_id: "acct-viewer",
        role: "viewer",
        devices: [
          {
            peer_key: member,
            device_fp: null,
            label: `Device (${(await fingerprint(member)).slice(3, 11)})`,
            approved_by: null,
            this_device: true,
          },
        ],
      },
    });
  });

  it("admits member-signed devices, returns scoped views, and removes their approval cascade", async () => {
    const claw = await linkedClaw();
    const { call, effects, log, service } = await tunnelApi(claw);
    const invite = await ownerInvite(claw, { email: "bob@example.com" });
    const inviteBody = { cap: invite.cap, proof_key: bytesToBase64url(invite.proofKey) };
    expect((await call(claw.w1, "POST", "invites", inviteBody)).status).toBe(200);
    const mail = await redemptionMail({
      clawId: claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId: "bob",
      email: "bob@example.com",
    });
    mail.message.payload.redemption = await signStatement(
      "InviteRedemption",
      { ...mail.message.payload.redemption.body, label: "  " },
      mail.signer,
    );
    expect(
      await claw.authority.redeem(mail.message.payload.redemption, mail.message.from),
    ).toMatchObject({ ok: true });
    expect(
      (
        await call(claw.w1, "POST", "statements", {
          statement: await claw.sign({
            op: "add",
            account_id: "bob",
            role: "operator",
            peer_keys: [mail.peerKey],
            invite_id: invite.inviteId,
          }),
        })
      ).status,
    ).toBe(200);
    const phone = await generateEd25519Signer();
    const peer = formatIrohEndpointKey(randomBytes(32));
    const target = {
      op: "add_member_device" as const,
      account_id: "bob",
      peer_key: peer,
      device_pub: formatEd25519PublicKey(phone.publicKey),
      label: "Chrome on Linux",
    };
    expect(
      (
        await call(mail.peerKey, "POST", "statements", {
          statement: await claw.sign(target, mail.signer),
        })
      ).status,
    ).toBe(200);
    const child = formatIrohEndpointKey(randomBytes(32));
    const childSigner = await generateEd25519Signer();
    expect(
      (
        await call(peer, "POST", "statements", {
          statement: await claw.sign(
            {
              ...target,
              peer_key: child,
              device_pub: formatEd25519PublicKey(childSigner.publicKey),
              label: "Chrome on Linux",
            },
            phone,
          ),
        })
      ).status,
    ).toBe(200);
    const view = (await call(peer, "GET", "membership")).body;
    expect(Object.keys(view).toSorted()).toEqual([
      "account_id",
      "binding_seq",
      "claw_id",
      "devices",
      "role",
      "seq",
    ]);
    expect(view).toMatchObject({
      account_id: "bob",
      binding_seq: 1,
      role: "operator",
      devices: [
        {
          peer_key: mail.peerKey,
          label: `Device (${(await fingerprint(formatEd25519PublicKey(mail.signer.publicKey))).slice(3, 11)})`,
          this_device: false,
          approved_by: { kind: "invite", invite_id: invite.inviteId },
        },
        {
          peer_key: peer,
          label: `Chrome on Linux (${(await fingerprint(target.device_pub)).slice(3, 11)})`,
          device_fp: await fingerprint(target.device_pub),
          this_device: true,
          approved_by: {
            kind: "member_device",
            device_fp: await fingerprint(formatEd25519PublicKey(mail.signer.publicKey)),
          },
        },
        {
          peer_key: child,
          label: `Chrome on Linux (${(await fingerprint(formatEd25519PublicKey(childSigner.publicKey))).slice(3, 11)})`,
          this_device: false,
        },
      ],
    });
    const ownerView = (await call(claw.w1, "GET", "membership")).body;
    expect(ownerView.members[0].devices.map((device: { label: string }) => device.label)).toEqual(
      view.devices.map((device: { label: string }) => device.label),
    );
    expect((await claw.authority.load())?.authority?.members.bob?.devices?.[peer]?.label).toBe(
      "Chrome on Linux",
    );
    const people = await service.linkStatus();
    expect(people.members?.[0]?.devices[1]).toMatchObject({
      peerKey: peer,
      label: `Chrome on Linux (${(await fingerprint(target.device_pub)).slice(3, 11)})`,
      deviceFp: await fingerprint(target.device_pub),
      lastSeen: expect.any(Number),
      approvedBy: { kind: "member_device" },
    });
    for (const route of ["invites", "node-invites"]) {
      expect(await call(peer, "POST", route, inviteBody)).toMatchObject({
        status: 403,
        body: { error: { code: "not_owner_device" } },
      });
    }
    expect(
      await call(peer, "POST", "statements", {
        statement: await claw.sign({ op: "set_role", account_id: "bob", role: "viewer" }, phone),
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "not_an_owner" } } });
    await claw.authority.bindToken("phone-token", "operator", peer);
    await claw.authority.bindToken("tablet-token", "operator", child);
    expect(
      (
        await call(mail.peerKey, "POST", "statements", {
          statement: await claw.sign({ op: "revoke_device", peer_key: peer }, mail.signer),
        })
      ).status,
    ).toBe(200);
    expect(effects.revokeDeviceTokens).toHaveBeenCalledWith(
      expect.arrayContaining([
        { deviceId: "phone-token", role: "operator", peerKey: peer },
        { deviceId: "tablet-token", role: "operator", peerKey: child },
      ]),
    );
    expect(effects.captureConnections).toHaveBeenCalledWith([peer, child]);
    expect((await call(peer, "GET", "membership")).status).toBe(403);
    expect((await call(child, "GET", "membership")).status).toBe(403);
    expect((await call(mail.peerKey, "GET", "membership")).body.devices).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("member_device_added"));
    await service.stop();
  });

  it("refuses unknown-role and unlisted peers on every route before disclosing or mutating", async () => {
    const claw = await linkedClaw();
    const peer = formatIrohEndpointKey(randomBytes(32));
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "acct-guest",
          role: "guest",
          peer_keys: [peer],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    const { call, service, effects } = await tunnelApi(claw);
    const { change } = await sasApproval(claw);
    const invite = await ownerInvite(claw, { email: "bob@example.com", role: "viewer" });
    const inviteBody = { cap: invite.cap, proof_key: bytesToBase64url(invite.proofKey) };
    const before = await claw.authority.ownerView(claw.w1);
    try {
      for (const caller of [peer, formatIrohEndpointKey(randomBytes(32))]) {
        for (const [method, route, body] of [
          ["GET", "membership", undefined],
          ["POST", "statements", { statement: change }],
          ["POST", "invites", inviteBody],
          ["POST", "node-invites", inviteBody],
          ["POST", "signout", undefined],
        ] as const) {
          expect.soft(await call(caller, method, route, body), `${caller} ${route}`).toMatchObject({
            status: 403,
            body: { error: { code: "not_admitted" } },
          });
        }
      }
      expect(effects.captureConnections).not.toHaveBeenCalled();
      expect(effects.closeConnections).not.toHaveBeenCalled();
      expect(await claw.authority.ownerView(claw.w1)).toEqual(before);
    } finally {
      await service.stop();
    }
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
