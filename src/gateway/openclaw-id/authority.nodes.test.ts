import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  bytesToBase64url,
  computeNodeRedemptionProof,
  deriveInviteProofKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateInviteSecret,
  inviteSecretHash,
  nodeVerificationCode,
  PENDING_REDEMPTION_TTL_SECONDS,
  signStatement,
  type MembershipTarget,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { VERSION } from "../../version.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import { linkedClaw, nowSeconds, serviceFor } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";

// Exercise the signed mailbox/authority boundary; transport and device pairing have separate owners.
async function nodeInvite() {
  const claw = await linkedClaw();
  const stored = claw.authority.current()!;
  const { nodes: _nodes, node_invites: _invites, ...legacy } = stored.authority!;
  // Exercise all node lifecycles after loading a persisted pre-node Labs claw.
  await claw.store.write({ ...stored, authority: legacy } as StoredClaw);
  claw.authority = createOpenClawIdAuthority(claw.store);
  claw.sign = async (target: MembershipTarget, signer?: StatementSigner) =>
    signStatement(
      "MembershipChange",
      {
        claw_id: claw.clawId,
        seq: (await claw.authority.load())!.authority!.seq + 1,
        target,
        issued_at: nowSeconds(),
      },
      signer ?? claw.device,
    );
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signStatement(
    "NodeInviteCap",
    {
      claw_id: claw.clawId,
      invite_id,
      label: "Office node",
      created_at: nowSeconds(),
      expires_at: nowSeconds() + 600,
      secret_hash: await inviteSecretHash(proofKey),
    },
    claw.device,
  );
  const signer = await generateEd25519Signer();
  const peerKey = formatIrohEndpointKey(signer.publicKey);
  const parts = { claw_id: claw.clawId, invite_id, peer_key: peerKey };
  const redemption = await signStatement(
    "NodeRedemption",
    {
      ...parts,
      description: {
        display_name: "Office node",
        platform: "linux",
        commands: ["system.run"],
        caps: ["system"],
      },
      proof: await computeNodeRedemptionProof(proofKey, parts),
      requested_at: nowSeconds(),
    },
    signer,
  );
  const approve = () =>
    claw.sign({ op: "add_node", peer_key: peerKey, label: "Office node", invite_id });
  return { claw, cap, proofKey, peerKey, redemption, approve, inviteId: invite_id };
}

describe("accountless node authority", () => {
  afterEach(() => vi.useRealTimers());

  it("registers through RPC and restricts the node-invites HTTP route to owner devices", async () => {
    const { claw, cap, proofKey, redemption, approve, peerKey } = await nodeInvite();
    const { service } = serviceFor(claw.authority);
    const respond = vi.fn();
    // The handler owns parameter decoding; the real service and authority verify the signature.
    await openclawIdHandlers["openclawId.authority"]!({
      params: { action: "register_node_invite", cap, proofKey: bytesToBase64url(proofKey) },
      client: { internal: { isLocalClient: true } },
      context: {
        openclawIdService: service,
        getRuntimeConfig: () => ({
          gateway: {
            openclawId: { enabled: true, discoveryUrl: "https://directory.example.test" },
          },
        }),
      },
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "applied",
        discoveryUrl: "https://directory.example.test",
        version: VERSION,
      }),
    );
    await claw.authority.redeemNode(redemption);
    const pending = await service.linkStatus();
    expect(pending.nodeInvites?.[0]?.pending).toMatchObject({
      peerKey,
      description: redemption.body.description,
      verificationCode: await nodeVerificationCode(redemption.body),
    });
    await service.submitStatement("tunnel", await approve());
    expect((await service.linkStatus()).nodes?.[0]).toMatchObject({
      peerKey,
      description: redemption.body.description,
    });
    const nextCap = await signStatement(
      "NodeInviteCap",
      { ...cap.body, invite_id: "f".repeat(32) },
      claw.device,
    );
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((req, res) => {
          void service.serveTunnelApi(req, res, String(req.headers["x-test-peer"]));
        }),
    });
    try {
      const post = (peer: string) =>
        fetch(`http://127.0.0.1:${reservation.claim.port}/_openclaw-id/v1/node-invites`, {
          method: "POST",
          headers: { "x-test-peer": peer, "content-type": "application/json" },
          body: JSON.stringify({ cap: nextCap, proof_key: bytesToBase64url(proofKey) }),
        });
      // Even an admitted node with a captured valid owner signature cannot register invitations.
      const denied = await post(peerKey);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: { code: "not_owner_device" } });
      const accepted = await post(claw.w1);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ status: "applied" });
    } finally {
      await reservation.releaseListener();
      await reservation.claim.release();
      await service.stop();
    }
  });

  it("dispatches node mail separately, persists pending, admits only owner-approved nodes and removes them", async () => {
    const { claw, cap, proofKey, peerKey, redemption, approve, inviteId } = await nodeInvite();
    expect(await claw.authority.registerNodeInvite({ cap, proofKey }, "tunnel")).toMatchObject({
      ok: true,
    });
    const redeem = vi.fn();
    const results = await applyMailboxMessage(
      {
        message_id: "node-mail",
        claw_id: claw.clawId,
        to: "gateway",
        from: {
          account_id: null,
          email: null,
          display_name: null,
          device_fp: `fp:${"c1".repeat(32)}`,
          reported_by: "openclaw-id",
        },
        location_hint: null,
        payload: { kind: "node_redemption", redemption },
        received_at: nowSeconds(),
        expires_at: nowSeconds() + 600,
      },
      {
        submit: (input) => claw.authority.submit(input, "mailbox"),
        redeem,
        redeemNode: (input) => claw.authority.redeemNode(input),
      },
    );
    expect(results).toMatchObject([{ ok: true, status: "pending" }]);
    expect(redeem).not.toHaveBeenCalled();
    expect(await claw.authority.resolvePeer(peerKey)).toBeUndefined();
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(peerKey);
    const pending = await claw.authority.ownerView(claw.w1);
    expect(pending?.node_invites).toMatchObject([
      { inviteId, status: "pending", pending: { peerKey } },
    ]);
    expect(pending?.node_invites[0]?.pending?.verificationCode).toBe(
      await nodeVerificationCode(redemption.body),
    );
    expect(pending?.node_invites[0]?.pending?.description).toEqual(redemption.body.description);
    expect(JSON.stringify(pending)).not.toContain(bytesToHex(proofKey));
    const reloaded = createOpenClawIdAuthority(claw.store);
    expect((await reloaded.ownerView(claw.w1))?.node_invites).toEqual(pending?.node_invites);
    expect(await claw.authority.submit(await approve(), "tunnel")).toMatchObject({ ok: true });
    expect(await claw.authority.resolvePeer(peerKey)).toEqual({
      kind: "node",
      peerKey,
      authority: {
        clawId: claw.clawId,
        rootPub: claw.authority.current()!.authority!.anchor.root_pub,
        listedSeq: 2,
      },
    });
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(peerKey);
    expect(await claw.authority.ownerView(peerKey)).toBeUndefined();
    expect((await claw.authority.ownerView(claw.w1))?.node_invites[0]?.status).toBe("approved");
    await claw.authority.bindToken("node-device", "node", peerKey);
    expect(await claw.authority.orphanedTokens()).toEqual([]);
    const { service, effects } = serviceFor(claw.authority);
    expect(
      await service.submitStatement(
        "tunnel",
        await claw.sign({ op: "remove_node", peer_key: peerKey }),
      ),
    ).toMatchObject({
      ok: true,
      events: expect.arrayContaining([{ type: "remove_node_pairings", peer_keys: [peerKey] }]),
    });
    expect(claw.authority.currentPeer(peerKey)).toBeUndefined();
    expect(effects.removeNodePairings).toHaveBeenCalledWith([peerKey]);
    expect(effects.closeConnections).toHaveBeenCalled();
    expect(effects.revokeDeviceTokens).toHaveBeenCalledWith([
      { deviceId: "node-device", role: "node", peerKey },
    ]);
    expect(await claw.authority.orphanedTokens()).toEqual([]);
    await service.stop();
  });

  it("rejects mailbox registration, wrong proof and approvals after pending expiry", async () => {
    const { claw, cap, proofKey, redemption, approve, peerKey } = await nodeInvite();
    expect(await claw.authority.registerNodeInvite({ cap, proofKey }, "mailbox")).toMatchObject({
      ok: false,
      code: "not_direct",
    });
    expect(
      await claw.authority.registerNodeInvite({ cap, proofKey: new Uint8Array(32) }, "tunnel"),
    ).toMatchObject({ ok: false, code: "bad_proof" });
    await claw.authority.registerNodeInvite({ cap, proofKey }, "tunnel");
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = nowSeconds() + PENDING_REDEMPTION_TTL_SECONDS;
    await claw.authority.redeemNode(redemption);
    expect(claw.authority.nextPeopleExpiry()).toBe(deadline);
    vi.setSystemTime(deadline * 1000);
    expect((await claw.authority.ownerView(claw.w1))?.node_invites[0]?.status).toBe("expired");
    expect(await claw.authority.submit(await approve(), "tunnel")).toMatchObject({
      ok: false,
      code: "invite_not_pending",
    });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(peerKey);
    expect(claw.authority.current()?.authority?.node_invites).toEqual({});
  });
});

it("reconciles after late effect binding even with Labs off, without retiring current listings", async () => {
  const { claw, cap, proofKey, redemption, approve, peerKey } = await nodeInvite();
  await claw.authority.registerNodeInvite({ cap, proofKey }, "tunnel");
  await claw.authority.redeemNode(redemption);
  await claw.authority.submit(await approve(), "tunnel");
  const source = {
    approvedVia: "openclaw-id-node" as const,
    peerKey,
    authority: claw.authority.currentPeer(peerKey)!.authority!,
  };
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: false }),
    getStateDir: () => "/unused",
    getGatewayServer: () => undefined,
    createAuthority: async () => claw.authority,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  // Mirrors runtime preparation: token hydration happens before removal effects are bound.
  await service.loadTokenBindings();
  const reconciled = new Promise<void>((resolve, reject) => {
    service.bindEffects(async () => ({
      captureConnections: () => [],
      closeConnections: () => {},
      revokeDeviceTokens: async (tokens) => [...tokens],
      reconcileNodePairings: async (isCurrent) => {
        try {
          expect(isCurrent(source)).toBe(true);
          expect(
            isCurrent({ ...source, authority: { ...source.authority, rootPub: "reset-root" } }),
          ).toBe(false);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    }));
  });
  try {
    await reconciled;
  } finally {
    await service.stop();
  }
});
