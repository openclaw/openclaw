import { describe, expect, it, vi } from "vitest";
import {
  deriveRootSigner,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateKitSecret,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
  type MembershipTarget,
  type SignedStatement,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import { memoryStore as profileFixture } from "./openclaw-id.test-support.js";
import { createOpenClawIdService, type OpenClawIdEffects } from "./service.js";

const K_SRV = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
const now = () => Math.floor(Date.now() / 1000);

function memoryStore() {
  let record: StoredClaw | undefined;
  return {
    profiles: profileFixture().profiles,
    read: async () => record,
    write: async (next: StoredClaw) => {
      record = structuredClone(next);
    },
  };
}

// A linked claw: root R pinned, owner device D1 (with tunnel key W1) admitted.
async function linkedClaw() {
  const authority = createOpenClawIdAuthority(memoryStore());
  const kGw = formatEd25519PublicKey((await generateEd25519Signer()).publicKey);
  const prep = await authority.prepareLink({
    kSrv: K_SRV,
    kGw,
    hostname: "studio-k7x2q.claws.example.test",
  });
  if ("ok" in prep) {
    throw new Error(prep.detail);
  }
  const root = await deriveRootSigner(generateKitSecret());
  const device = await generateEd25519Signer();
  const w1 = formatIrohEndpointKey(randomBytes(32));
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [w1],
      label: "phone",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: now(),
      expires_at: null,
      root_epoch: 1,
    },
    root,
  );
  const change = await signStatement(
    "MembershipChange",
    { claw_id: prep.claw_id, seq: 1, target: { op: "add_owner_device", cert }, issued_at: now() },
    root,
  );
  const binding = await signStatement("ServerBinding", { ...prep, issued_at: now() }, root);
  const linked = await authority.commitLink(
    { root_pub: formatEd25519PublicKey(root.publicKey), owner_device: change, binding },
    "local_operator",
    { kSrv: K_SRV, kGw },
  );
  expect(linked.ok).toBe(true);
  const sign = (seq: number, target: MembershipTarget, signer: StatementSigner = device) =>
    signStatement(
      "MembershipChange",
      { claw_id: prep.claw_id, seq, target, issued_at: now() },
      signer,
    );
  return { authority, cert, device, root, w1, sign, clawId: prep.claw_id };
}

function serviceFor(authority: Awaited<ReturnType<typeof linkedClaw>>["authority"]) {
  const effects: OpenClawIdEffects = {
    captureConnections: vi.fn((keys: readonly string[]) =>
      keys.map((key) => `conn-${key.slice(5, 9)}`),
    ),
    cancelRuns: vi.fn(async (connections: readonly string[]) => connections.length),
    closeConnections: vi.fn(),
    revokeDeviceTokens: vi.fn(async (tokens) => [...tokens]),
    describeActivity: vi.fn((keys: readonly string[]) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          {
            connections: 1,
            lastSeenAt: 1_700_000_000_000,
            runs: [{ runId: "r1", sessionKey: "s1" }],
          },
        ]),
      ),
    ),
  };
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: true }),
    getStateDir: () => "/nonexistent/openclaw-id-test",
    log: { info: vi.fn(), warn: vi.fn() },
    createAuthority: async () => authority,
  });
  service.bindEffects(async () => effects);
  return { service, effects };
}

describe("Gateway membership authority and enforcement", () => {
  it("adds a member from an owner device over the tunnel and admits its key", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const bob = formatIrohEndpointKey(randomBytes(32));
    const add = await claw.sign(2, {
      op: "add",
      account_id: "acct-bob",
      role: "operator",
      peer_keys: [bob],
      invite_id: null,
    });
    expect(await service.submitStatement("tunnel", add)).toMatchObject({ ok: true });
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(bob);
  });

  // Spec section 11 #12 and #4: removal takes effect at the claw without Discovery.
  it("removes a member: cuts tunnel access, cancels its runs, closes sessions and revokes tokens", async () => {
    const claw = await linkedClaw();
    const { service, effects } = serviceFor(claw.authority);
    const bob = formatIrohEndpointKey(randomBytes(32));
    await service.submitStatement(
      "tunnel",
      await claw.sign(2, {
        op: "add",
        account_id: "acct-bob",
        role: "operator",
        peer_keys: [bob],
        invite_id: null,
      }),
    );
    await claw.authority.bindToken("bob-device", "operator", bob);
    const listed = await service.linkStatus();
    expect(listed.members).toEqual([
      expect.objectContaining({
        accountId: "acct-bob",
        role: "operator",
        devices: [
          {
            peerKey: bob,
            connections: 1,
            lastSeenAt: 1_700_000_000_000,
            runs: [{ runId: "r1", sessionKey: "s1" }],
          },
        ],
      }),
    ]);
    const result = await service.submitStatement(
      "local_operator",
      await claw.sign(3, { op: "remove", account_id: "acct-bob" }),
    );
    expect(result).toMatchObject({
      ok: true,
      removal: { devices: 1, connectionsClosed: 1, runsCancelled: 1 },
    });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(bob);
    const connection = `conn-${bob.slice(5, 9)}`;
    expect(effects.captureConnections).toHaveBeenCalledWith([bob]);
    expect(effects.cancelRuns).toHaveBeenCalledWith([connection]);
    expect(effects.closeConnections).toHaveBeenCalledWith([connection]);
    expect(effects.revokeDeviceTokens).toHaveBeenCalledWith([
      { deviceId: "bob-device", role: "operator", peerKey: bob },
    ]);
    expect(claw.authority.tokenBinding("bob-device", "operator")).toBeUndefined();
  });

  it("keeps a removed key's token bound until its revocation is confirmed", async () => {
    const claw = await linkedClaw();
    const { service, effects } = serviceFor(claw.authority);
    const bob = formatIrohEndpointKey(randomBytes(32));
    await service.submitStatement(
      "tunnel",
      await claw.sign(2, {
        op: "add",
        account_id: "acct-bob",
        role: "operator",
        peer_keys: [bob],
        invite_id: null,
      }),
    );
    await claw.authority.bindToken("bob-device", "operator", bob);
    vi.mocked(effects.revokeDeviceTokens).mockImplementationOnce(async () => []);
    await service.submitStatement(
      "local_operator",
      await claw.sign(3, { op: "remove", account_id: "acct-bob" }),
    );
    // Still bound to the removed key, so ordinary ingress keeps refusing it.
    expect(claw.authority.tokenBinding("bob-device", "operator")).toBe(bob);
    expect(await claw.authority.orphanedTokens()).toEqual([
      { deviceId: "bob-device", role: "operator", peerKey: bob },
    ]);
  });

  it("refuses membership changes from a client that is neither relayed nor direct loopback", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const change = await claw.sign(2, { op: "remove", account_id: "nobody" });
    expect(await service.submitStatement(undefined, change)).toMatchObject({
      ok: false,
      code: "not_direct",
    });
  });

  it("refuses a replayed change with a stale seq", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const bob = formatIrohEndpointKey(randomBytes(32));
    const add = await claw.sign(2, {
      op: "add",
      account_id: "b",
      role: "viewer",
      peer_keys: [bob],
      invite_id: null,
    });
    expect(await service.submitStatement("tunnel", add)).toMatchObject({ ok: true });
    expect(await service.submitStatement("tunnel", add)).toMatchObject({
      ok: false,
      code: "seq_conflict",
    });
  });

  // Spec section 11 #3: Discovery cannot forge or relay a device approval.
  it("refuses a device-signed approval delivered through the mailbox", async () => {
    const claw = await linkedClaw();
    const bob = formatIrohEndpointKey(randomBytes(32));
    const add = (await claw.sign(2, {
      op: "add",
      account_id: "acct-bob",
      role: "operator",
      peer_keys: [bob],
      invite_id: null,
    })) as SignedStatement;
    const [result] = await applyMailboxMessage(
      {
        message_id: "m1",
        claw_id: "x",
        to: "gateway",
        from: {
          account_id: "acct-mallory",
          email: null,
          display_name: null,
          device_fp: null,
          reported_by: "openclaw-id",
        },
        location_hint: null,
        payload: { kind: "root_statement", statements: [add] },
        received_at: now(),
        expires_at: now() + 60,
      },
      {
        submit: (statement) => claw.authority.submit(statement, "mailbox"),
        redeem: (redemption, identity) => claw.authority.redeem(redemption, identity),
      },
    );
    expect(result).toMatchObject({ ok: false, code: "not_direct" });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(bob);
  });
  it("lists only active owner devices after an owner device revokes another", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const laptop = await generateEd25519Signer();
    const laptopCert = await signStatement(
      "OwnerDeviceCert",
      {
        device_pub: formatEd25519PublicKey(laptop.publicKey),
        peer_keys: [formatIrohEndpointKey(randomBytes(32))],
        label: "laptop",
        scope: "owner",
        caps: [...OWNER_CAPABILITIES],
        issued_at: now(),
        expires_at: null,
        root_epoch: 1,
      },
      claw.root,
    );
    const added = await service.submitStatement(
      "local_operator",
      await claw.sign(2, { op: "add_owner_device", cert: laptopCert }, claw.root),
    );
    expect(added).toMatchObject({ ok: true });
    expect((await service.linkStatus()).ownerDevices?.map((device) => device.label)).toEqual([
      "phone",
      "laptop",
    ]);
    const revocation = await signStatement(
      "Revocation",
      {
        claw_id: claw.clawId,
        seq: 2,
        target_fp: await fingerprint(laptopCert.body.device_pub),
        target_kind: "owner_device",
        reason: "lost",
        root_epoch: 1,
        issued_at: now(),
      },
      claw.device,
    );
    expect(await service.submitStatement("tunnel", revocation)).toMatchObject({ ok: true });
    expect((await service.linkStatus()).ownerDevices?.map((device) => device.label)).toEqual([
      "phone",
    ]);
  });
});
