import { describe, expect, it, vi } from "vitest";
import {
  checkDescriptorRootReset,
  deriveRootSigner,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateKitSecret,
  OWNER_CAPABILITIES,
  randomBytes,
  ROOT_EPOCH,
  signStatement,
  verifyBindingForPin,
  verifyRootReset,
  type ClawDescriptor,
  type IrohEndpointKey,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import {
  linkedClaw,
  memoryStore,
  nowSeconds,
  ownerInvite,
  serviceFor,
} from "./openclaw-id.test-support.js";
import { publishClaw } from "./publisher.js";
import type { ResetPreparation } from "./reset-operations.js";

const peer = () => formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;

// A linked claw with a member, a node, an open invite and tunnel-bound tokens, published at
// Discovery under its first binding.
async function populatedClaw() {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  const invite = await ownerInvite(claw, { email: "bob@example.test" });
  expect((await claw.authority.registerInvite(invite, "tunnel")).ok).toBe(true);
  const member = peer();
  const node = peer();
  const record = structuredClone((await store.read())!);
  record.authority!.members["acct-bob"] = {
    role: "operator",
    peer_keys: [member],
    last_seen: { [member]: nowSeconds() },
    listed_seq: [record.authority!.seq],
  };
  record.authority!.nodes[node] = {
    description: { display_name: "mac", platform: "macos", commands: [], caps: [] },
    label: "mac",
    listed_seq: record.authority!.seq,
    added_by: "root",
    last_seen: nowSeconds(),
  };
  record.token_bindings = [
    { device_id: "dev-phone", role: "operator", peer_key: claw.w1, bound_at: nowSeconds() },
    { device_id: "dev-bob", role: "operator", peer_key: member, bound_at: nowSeconds() },
  ];
  record.discovery = {
    ...record.discovery,
    owner_account_id: "acct-owner",
    published_binding_seq: 1,
    published_snapshot_seq: record.authority!.seq,
  };
  await store.write(record);
  // A fresh authority over the edited record, as after a Gateway restart.
  const authority = createOpenClawIdAuthority(store);
  return { ...claw, authority, store, member, node, before: record };
}

// What the CLI or the browser signs with a new kit for `prep`.
async function signReset(
  prep: ResetPreparation,
  options: { device?: StatementSigner; root?: StatementSigner } = {},
) {
  const root = options.root ?? (await deriveRootSigner(generateKitSecret()));
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: prep.binding_seq,
      root_epoch: ROOT_EPOCH,
      issued_at: nowSeconds(),
    },
    root,
  );
  let owner_device: unknown;
  if (options.device) {
    const cert = await signStatement(
      "OwnerDeviceCert",
      {
        device_pub: formatEd25519PublicKey(options.device.publicKey),
        peer_keys: [],
        label: "this browser",
        scope: "owner",
        caps: [...OWNER_CAPABILITIES],
        issued_at: nowSeconds(),
        expires_at: null,
        root_epoch: ROOT_EPOCH,
      },
      root,
    );
    owner_device = await signStatement(
      "MembershipChange",
      {
        claw_id: prep.claw_id,
        seq: prep.owner_device_seq,
        target: { op: "add_owner_device", cert },
        issued_at: nowSeconds(),
      },
      root,
    );
  }
  return {
    root,
    input: { root_pub: formatEd25519PublicKey(root.publicKey), binding, owner_device },
  };
}

async function prepared(service: ReturnType<typeof serviceFor>["service"]) {
  const prep = await service.resetOwner("prepare", "local_operator");
  if ("ok" in prep) {
    throw new Error(`prepare refused: ${prep.code}`);
  }
  return prep as ResetPreparation;
}

describe("owner reset", () => {
  it("is refused over the tunnel and without an OpenClaw ID channel", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    const prep = await prepared(service);
    const { input } = await signReset(prep);
    for (const channel of ["tunnel", undefined] as const) {
      expect(await service.resetOwner("prepare", channel)).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
      expect(await service.resetOwner("commit", channel, input)).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
    }
    // The authority refuses a tunnel commit too, whoever calls it.
    const gateway = await generateEd25519Signer();
    expect(await claw.authority.commitReset(input, "tunnel", gateway)).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect((await claw.store.read())?.authority).toEqual(claw.before.authority);
  });

  it("removes everyone, keeps the claw's keys and data, and continues the seqs", async () => {
    const claw = await populatedClaw();
    const { service, effects } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    const prep = await prepared(service);
    expect(prep).toMatchObject({
      binding_seq: 2,
      owner_device_seq: claw.before.authority!.seq + 2,
      removes: { ownerDevices: 1, members: 1, nodes: 1, invites: 1 },
    });
    const { input } = await signReset(prep);
    const result = await service.resetOwner("commit", "local_operator", input);
    expect(result).toMatchObject({
      ok: true,
      reset: true,
      bindingSeq: 2,
      removed: { ownerDevices: 1, members: 1, nodes: 1, invites: 1 },
      removal: { devices: 3, connectionsClosed: 3 },
    });

    const after = (await claw.store.read())!;
    const before = claw.before;
    expect(after.authority).toEqual({
      claw_id: before.claw_id,
      anchor: { root_pub: input.root_pub },
      seq: before.authority!.seq + 1,
      owner_devices: {},
      members: {},
      invites: {},
      nodes: {},
      node_invites: {},
    });
    expect(after.claw_id).toBe(before.claw_id);
    expect(after.hostname).toBe(before.hostname);
    expect(after.binding).toEqual(input.binding);
    expect(after.binding?.body).toMatchObject({
      k_srv: before.binding!.body.k_srv,
      k_gw: before.binding!.body.k_gw,
      hostname: before.hostname,
      binding_seq: 2,
    });
    expect(after.discovery.owner_account_id).toBe("acct-owner");
    expect(after.invite_reports).toEqual({});
    expect(after.member_approved_at).toEqual({});

    // Every listed key and tunnel-bound token lost access: sessions closed, tokens revoked.
    const removed = [claw.w1, claw.member, claw.node];
    expect(effects.captureConnections).toHaveBeenCalledWith(expect.arrayContaining(removed));
    expect(vi.mocked(effects.captureConnections).mock.calls[0]?.[0]).toHaveLength(3);
    expect(effects.closeConnections).toHaveBeenCalledOnce();
    expect(effects.cancelRuns).toHaveBeenCalledOnce();
    expect(effects.revokeDeviceTokens).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: "dev-phone" }),
        expect.objectContaining({ deviceId: "dev-bob" }),
      ]),
    );
    expect(after.token_bindings).toEqual([]);
    expect(effects.removeNodePairings).toHaveBeenCalledWith([claw.node]);
    expect(await claw.authority.admittedPeerKeys()).toEqual({
      seq: before.authority!.seq + 1,
      admitted: [],
    });
    expect(await claw.authority.resolvePeer(claw.w1)).toBeUndefined();
  });

  it("publishes a RootReset from the current K_gw that the protocol and Discovery's check accept", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    const { input } = await signReset(await prepared(service));
    await service.resetOwner("commit", "local_operator", input);
    const after = (await claw.store.read())!;
    const previous = {
      root_pub: claw.before.authority!.anchor.root_pub,
      binding: claw.before.binding!,
    };
    expect(after.reset).toMatchObject({
      previous_root_pub: previous.root_pub,
      previous_binding: previous.binding,
      statement: { type: "RootReset", signer: previous.binding.body.k_gw },
    });
    expect(after.reset?.statement.body).toMatchObject({
      claw_id: after.claw_id,
      new_root_pub: input.root_pub,
      binding_seq: 2,
    });
    const now = nowSeconds();
    const next = { root_pub: input.root_pub, binding: after.binding! };
    expect(await verifyRootReset(previous, after.reset!.statement, next, { now })).toMatchObject({
      ok: true,
    });

    // The descriptor carries the evidence, signed requests need no link code (same K_gw), and
    // Discovery's stored-descriptor check accepts the new root.
    const client = {
      registerClaw: vi.fn(),
      publishDescriptor: vi.fn(async () => {}),
      publishSnapshot: vi.fn(async () => {}),
    };
    const outcome = await publishClaw({
      record: after,
      relayUrl: "https://relay.example.test/",
      // SAFETY: the test client implements only the calls publishClaw makes for a registered claw.
      client: client as never,
      signer: await generateEd25519Signer(),
    });
    expect(outcome.state).toBe("published");
    const [[descriptor, options]] = client.publishDescriptor.mock.calls as unknown as [
      [ClawDescriptor, unknown],
    ];
    expect(options).toBeUndefined();
    expect(descriptor.reset).toEqual(after.reset);
    const stored: ClawDescriptor = { ...descriptor, ...previous, reset: undefined };
    delete stored.reset;
    expect(await checkDescriptorRootReset(stored, descriptor, { now })).toMatchObject({ ok: true });

    // A browser pinned to the old root and K_gw sees the reset; one without the pinned K_gw,
    // or a reset signed by another key, sees the substitution warning.
    const pin = {
      claw_id: after.claw_id,
      root_fp: await fingerprint(previous.root_pub),
      binding_seq: 1,
      k_gw: previous.binding.body.k_gw,
    };
    const context = { host: after.hostname!, now };
    const evidence = {
      root_pub: descriptor.root_pub,
      binding: descriptor.binding,
      reset: descriptor.reset,
    };
    expect(await verifyBindingForPin(evidence, pin, context)).toMatchObject({
      code: "owner_reset",
    });
    const forged = await signStatement(
      "RootReset",
      after.reset!.statement.body,
      await generateEd25519Signer(),
    );
    expect(
      await verifyBindingForPin(
        { ...evidence, reset: { ...after.reset!, statement: forged } },
        pin,
        context,
      ),
    ).toMatchObject({ code: "root_mismatch" });
    expect(
      await checkDescriptorRootReset(
        stored,
        { ...descriptor, reset: { ...after.reset!, statement: forged } },
        { now },
      ),
    ).toMatchObject({ ok: false });
  });

  it("enrolls the resetting browser as the first owner device under the new root", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    const device = await generateEd25519Signer();
    const { input } = await signReset(await prepared(service), { device });
    expect(await service.resetOwner("commit", "local_operator", input)).toMatchObject({ ok: true });
    const state = (await claw.store.read())!.authority!;
    expect(state.seq).toBe(claw.before.authority!.seq + 2);
    expect(Object.values(state.owner_devices).map((owner) => owner.cert.body.device_pub)).toEqual([
      formatEd25519PublicKey(device.publicKey),
    ]);
    expect(Object.values(state.owner_devices)[0]?.approved_by).toBe("root");
  });

  it("refuses the old kit's root, a stale binding and other keys, changing nothing", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    const prep = await prepared(service);
    const same = await signReset(prep, { root: claw.root });
    expect(await service.resetOwner("commit", "local_operator", same.input)).toMatchObject({
      ok: false,
      code: "reset_mismatch",
    });
    const stale = await signReset({ ...prep, binding_seq: 1 });
    expect(await service.resetOwner("commit", "local_operator", stale.input)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const otherKeys = await signReset({ ...prep, k_srv: peer() });
    expect(await service.resetOwner("commit", "local_operator", otherKeys.input)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const unsigned = await signReset(prep);
    const wrongSigner = {
      ...unsigned.input,
      root_pub: formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
    };
    expect(await service.resetOwner("commit", "local_operator", wrongSigner)).toMatchObject({
      ok: false,
    });
    const after = (await claw.store.read())!;
    expect(after.authority).toEqual(claw.before.authority);
    expect(after.binding).toEqual(claw.before.binding);
    expect(after.reset).toBeUndefined();
  });

  it("refuses a second reset until Discovery confirmed the first, even after a partial publish", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, { enabled: true }, claw.stateDir);
    await service.resetOwner(
      "commit",
      "local_operator",
      (await signReset(await prepared(service))).input,
    );
    // The descriptor may have landed without its snapshot: binding 2 stays unconfirmed here.
    expect(await claw.authority.prepareReset()).toMatchObject({
      ok: false,
      code: "reset_unpublished",
    });
    expect(
      await service.resetOwner("commit", "local_operator", {
        root_pub: undefined,
        binding: undefined,
      }),
    ).toMatchObject({
      ok: false,
      code: "reset_unpublished",
    });
    await claw.authority.recordDiscovery({ published_binding_seq: 2 });
    expect(await claw.authority.prepareReset()).toMatchObject({ binding_seq: 3 });
  });

  it("is refused while a move to new keys is unpublished, and a move waits for the reset", async () => {
    const claw = await populatedClaw();
    const record: StoredClaw = structuredClone((await claw.store.read())!);
    const moved = { ...record, discovery: { ...record.discovery, published_binding_seq: 0 } };
    moved.binding = await signStatement(
      "ServerBinding",
      { ...record.binding!.body, binding_seq: 2 },
      claw.root,
    );
    await claw.store.write(moved);
    const authority = createOpenClawIdAuthority(claw.store);
    expect(await authority.prepareReset()).toMatchObject({ ok: false, code: "rebind_unpublished" });

    const fresh = await populatedClaw();
    const { service } = serviceFor(fresh.authority, { enabled: true }, fresh.stateDir);
    await service.resetOwner(
      "commit",
      "local_operator",
      (await signReset(await prepared(service))).input,
    );
    expect(
      await fresh.authority.prepareRebind({
        kSrv: peer(),
        kGw: formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
      }),
    ).toMatchObject({ ok: false, code: "reset_unpublished" });
  });
});
