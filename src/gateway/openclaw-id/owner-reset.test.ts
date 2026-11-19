import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import * as tunnelRuntime from "./tunnel-runtime.js";

const peer = () => formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;

const CODE = "LINK-CODE-1";
const config = {
  enabled: true,
  discoveryUrl: "https://discovery.example.test",
  relayUrl: "https://relay.example.test/",
};

type DiscoveryCall = { method: string; path: string; body: Record<string, unknown> };

// A Discovery that knows CODE as the owner account's code, publishes `discoveryHas` (set from
// each claw's stored root and binding) and accepts every publication. The tunnel never starts
// here: remote access restarts after a reset and fails, which is reported.
let discovery: DiscoveryCall[];
let discoveryHas: { root_pub?: unknown; binding?: unknown } = {};
beforeEach(() => {
  discovery = [];
  vi.spyOn(tunnelRuntime, "startTunnelRuntime").mockRejectedValue(new Error("no tunnel in tests"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const text = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : "";
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    discovery.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname.endsWith("/published-descriptor")) {
      return body.code === CODE
        ? Response.json({ descriptor: discoveryHas })
        : Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const published = () => discovery.filter((call) => call.path.endsWith("/descriptor"));

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
  discoveryHas = { root_pub: record.authority!.anchor.root_pub, binding: record.binding };
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

const nothing = { root_pub: undefined, binding: undefined };

async function prepared(service: ReturnType<typeof serviceFor>["service"]) {
  const prep = await service.resetOwner("prepare", "local_operator", { ...nothing, code: CODE });
  if ("ok" in prep) {
    throw new Error(`prepare refused: ${JSON.stringify(prep)}`);
  }
  return prep as ResetPreparation;
}

describe("owner reset", () => {
  it("is refused over the tunnel and without an OpenClaw ID channel", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const prep = await prepared(service);
    const { input } = await signReset(prep);
    for (const channel of ["tunnel", undefined] as const) {
      expect(
        await service.resetOwner("prepare", channel, { ...nothing, code: CODE }),
      ).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
      expect(await service.resetOwner("commit", channel, { ...input, code: CODE })).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
    }
    // The authority refuses a tunnel commit too, whoever calls it.
    const gateway = await generateEd25519Signer();
    const staged = { kGw: prep.k_gw };
    expect(await claw.authority.commitReset(input, "tunnel", gateway, staged)).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect((await claw.store.read())?.authority).toEqual(claw.before.authority);
  });

  it("removes everyone, keeps K_srv and the data, moves to a new K_gw and continues the seqs", async () => {
    const claw = await populatedClaw();
    const { service, effects } = serviceFor(claw.authority, config, claw.stateDir);
    const prep = await prepared(service);
    expect(prep.k_gw).not.toBe(claw.before.binding!.body.k_gw);
    expect(prep).toMatchObject({
      k_srv: claw.before.binding!.body.k_srv,
      binding_seq: 2,
      owner_device_seq: claw.before.authority!.seq + 2,
      removes: { ownerDevices: 1, members: 1, nodes: 1, invites: 1 },
    });
    const { input } = await signReset(prep);
    const result = await service.resetOwner("commit", "local_operator", { ...input, code: CODE });
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
      k_gw: prep.k_gw,
      hostname: before.hostname,
      binding_seq: 2,
    });
    // The Gateway now signs with K_gw' from gateway.key; the old key is gone from this computer.
    const { loadGatewaySigner } = await import("./gateway-key.js");
    expect((await loadGatewaySigner(claw.stateDir, prep.k_gw)).pub).toBe(prep.k_gw);
    await expect(loadGatewaySigner(claw.stateDir, before.binding!.body.k_gw)).rejects.toMatchObject(
      { reason: "key_mismatch" },
    );
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

  it("publishes, with the owner's code and K_gw', a RootReset from the old K_gw that the protocol and Discovery's check accept", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const prep = await prepared(service);
    const { input } = await signReset(prep);
    expect(
      await service.resetOwner("commit", "local_operator", { ...input, code: CODE }),
    ).toMatchObject({ ok: true, publication: { state: "published" } });
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

    // The Gateway checked the code before committing (prepare and commit), then published the
    // new descriptor with its snapshot and the code in one write, as for any new K_gw.
    expect(discovery.filter((call) => call.path.endsWith("/published-descriptor"))).toHaveLength(2);
    const [publication] = published();
    expect(publication?.method).toBe("PUT");
    expect(publication?.body).toMatchObject({
      code: CODE,
      snapshot: { type: "MembershipSnapshot" },
    });
    const descriptor = publication!.body.descriptor as ClawDescriptor;
    expect(descriptor.reset).toEqual(after.reset);
    expect(descriptor.binding.body.k_gw).toBe(prep.k_gw);
    const stored: ClawDescriptor = { ...descriptor, ...previous, reset: undefined };
    delete stored.reset;
    expect(await checkDescriptorRootReset(stored, descriptor, { now })).toMatchObject({ ok: true });

    // publishClaw treats a reset like any new K_gw: without a code it asks for one.
    const client = {
      registerClaw: vi.fn(),
      publishDescriptor: vi.fn(async () => {}),
      publishSnapshot: vi.fn(async () => {}),
    };
    const unconfirmed = { ...after, discovery: { ...after.discovery, published_binding_seq: 1 } };
    expect(
      await publishClaw({
        record: unconfirmed,
        relayUrl: config.relayUrl,
        // SAFETY: the test client implements only the calls publishClaw makes for a registered claw.
        client: client as never,
        signer: await generateEd25519Signer(),
      }),
    ).toMatchObject({ state: "failed", code: "needs_link_code" });
    expect(client.publishDescriptor).not.toHaveBeenCalled();

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

  it("needs a valid code from the owner account before anything changes", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const { input } = await signReset(await prepared(service));
    for (const step of ["prepare", "commit"] as const) {
      expect(await service.resetOwner(step, "local_operator", input)).toMatchObject({
        ok: false,
        code: "needs_link_code",
      });
      expect(
        await service.resetOwner(step, "local_operator", { ...input, code: "SOMEONE-ELSES" }),
      ).toMatchObject({ ok: false, code: "code_invalid" });
    }
    const after = (await claw.store.read())!;
    expect(after.authority).toEqual(claw.before.authority);
    expect(after.binding).toEqual(claw.before.binding);
    expect(after.reset).toBeUndefined();
    expect(published()).toEqual([]);
  });

  it("is refused for a claw Discovery doesn't have yet, and when Discovery can't check the code", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
    expect(
      await service.resetOwner("prepare", "local_operator", { ...nothing, code: CODE }),
    ).toMatchObject({ ok: false, code: "discovery_unavailable" });
    const record = structuredClone((await claw.store.read())!);
    await claw.store.write({
      ...record,
      discovery: { ...record.discovery, owner_account_id: null },
    });
    const unpublished = createOpenClawIdAuthority(claw.store);
    const fresh = serviceFor(unpublished, config, claw.stateDir).service;
    expect(
      await fresh.resetOwner("prepare", "local_operator", { ...nothing, code: CODE }),
    ).toMatchObject({ ok: false, code: "not_published" });
  });

  it("is refused, changing nothing, when Discovery publishes another binding than this computer has", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const { input } = await signReset(await prepared(service));
    // Discovery moved on (a re-bind elsewhere, or this computer was restored from a backup).
    discoveryHas = {
      ...discoveryHas,
      binding: await signStatement(
        "ServerBinding",
        { ...claw.before.binding!.body, binding_seq: 2 },
        claw.root,
      ),
    };
    for (const step of ["prepare", "commit"] as const) {
      expect(
        await service.resetOwner(step, "local_operator", { ...input, code: CODE }),
      ).toMatchObject({ ok: false, code: "binding_superseded" });
    }
    expect((await claw.store.read())?.authority).toEqual(claw.before.authority);
    expect(published()).toEqual([]);
  });

  it("runs after a queued re-bind cancel, which can't delete the key the reset commits to", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const prep = await prepared(service);
    const { input } = await signReset(prep);
    const [reset, cancel] = await Promise.all([
      service.resetOwner("commit", "local_operator", { ...input, code: CODE }),
      service.rebind("cancel", "local_operator"),
    ]);
    expect(reset).toMatchObject({ ok: true, bindingSeq: 2 });
    expect(cancel).toEqual({ ok: true });
    const { loadGatewaySigner } = await import("./gateway-key.js");
    expect((await loadGatewaySigner(claw.stateDir, prep.k_gw)).pub).toBe(prep.k_gw);
  });

  it("reports a stored reset with its follow-up failure instead of a refusal", async () => {
    const claw = await populatedClaw();
    const { service, effects } = serviceFor(claw.authority, config, claw.stateDir);
    vi.mocked(effects.removeNodePairings!).mockRejectedValue(new Error("pairings unavailable"));
    const { input } = await signReset(await prepared(service));
    expect(
      await service.resetOwner("commit", "local_operator", { ...input, code: CODE }),
    ).toMatchObject({
      ok: true,
      reset: true,
      bindingSeq: 2,
      followUpError: "pairings unavailable",
    });
    expect((await claw.store.read())?.authority?.anchor.root_pub).toBe(input.root_pub);
  });

  it("enrolls the resetting browser as the first owner device under the new root", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const device = await generateEd25519Signer();
    const { input } = await signReset(await prepared(service), { device });
    expect(
      await service.resetOwner("commit", "local_operator", { ...input, code: CODE }),
    ).toMatchObject({ ok: true });
    const state = (await claw.store.read())!.authority!;
    expect(state.seq).toBe(claw.before.authority!.seq + 2);
    expect(Object.values(state.owner_devices).map((owner) => owner.cert.body.device_pub)).toEqual([
      formatEd25519PublicKey(device.publicKey),
    ]);
    expect(Object.values(state.owner_devices)[0]?.approved_by).toBe("root");
  });

  it("refuses the old kit's root, a stale binding and other keys, changing nothing", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    const prep = await prepared(service);
    const commit = (input: Awaited<ReturnType<typeof signReset>>["input"]) =>
      service.resetOwner("commit", "local_operator", { ...input, code: CODE });
    const same = await signReset(prep, { root: claw.root });
    expect(await commit(same.input)).toMatchObject({
      ok: false,
      code: "reset_mismatch",
    });
    const stale = await signReset({ ...prep, binding_seq: 1 });
    expect(await commit(stale.input)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const otherKeys = await signReset({ ...prep, k_srv: peer() });
    expect(await commit(otherKeys.input)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const sameGateway = await signReset({ ...prep, k_gw: claw.before.binding!.body.k_gw });
    expect(await commit(sameGateway.input)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    const unsigned = await signReset(prep);
    const wrongSigner = {
      ...unsigned.input,
      root_pub: formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
    };
    expect(await commit(wrongSigner)).toMatchObject({
      ok: false,
    });
    const after = (await claw.store.read())!;
    expect(after.authority).toEqual(claw.before.authority);
    expect(after.binding).toEqual(claw.before.binding);
    expect(after.reset).toBeUndefined();
  });

  it("refuses a second reset until Discovery confirmed the first", async () => {
    const claw = await populatedClaw();
    const { service } = serviceFor(claw.authority, config, claw.stateDir);
    // The descriptor write's answer is lost (it may have landed): binding 2 stays unconfirmed.
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).endsWith("/published-descriptor")
        ? Response.json({ descriptor: discoveryHas })
        : new Response("", { status: 503 }),
    );
    const first = await signReset(await prepared(service));
    await service.resetOwner("commit", "local_operator", { ...first.input, code: CODE });
    const staged = { kGw: formatEd25519PublicKey((await generateEd25519Signer()).publicKey) };
    expect(await claw.authority.prepareReset(staged)).toMatchObject({
      ok: false,
      code: "reset_unpublished",
    });
    expect(
      await service.resetOwner("commit", "local_operator", { ...nothing, code: CODE }),
    ).toMatchObject({
      ok: false,
      code: "reset_unpublished",
    });
    await claw.authority.recordDiscovery({ published_binding_seq: 2 });
    expect(await claw.authority.prepareReset(staged)).toMatchObject({ binding_seq: 3 });
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
    const staged = { kGw: formatEd25519PublicKey((await generateEd25519Signer()).publicKey) };
    expect(await authority.prepareReset(staged)).toMatchObject({
      ok: false,
      code: "rebind_unpublished",
    });

    const fresh = await populatedClaw();
    const { service } = serviceFor(fresh.authority, config, fresh.stateDir);
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).endsWith("/published-descriptor")
        ? Response.json({ descriptor: discoveryHas })
        : new Response("", { status: 503 }),
    );
    const { input } = await signReset(await prepared(service));
    await service.resetOwner("commit", "local_operator", { ...input, code: CODE });
    expect(
      await fresh.authority.prepareRebind({
        kSrv: peer(),
        kGw: formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
      }),
    ).toMatchObject({ ok: false, code: "reset_unpublished" });
  });
});
