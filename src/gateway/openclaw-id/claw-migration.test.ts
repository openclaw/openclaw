// Upgrading a claw record written before the allowlist model: history is dropped, each
// owner device records who approved it and its granted caps, and the record republishes.
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  snapshotBody,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { needsAllowlistUpgrade } from "./claw-migration.js";
import type { StoredClaw } from "./claw-store.js";
import { linkedClaw, memoryStore, nowSeconds } from "./openclaw-id.test-support.js";

// A linked record rewritten into the pre-allowlist shape: chains, chain_fps, a revoked
// list with one device behind it, published revocations and members without clocks.
async function legacyRecord() {
  const claw = await linkedClaw();
  const current = claw.authority.current()!;
  const state = current.authority!;
  const d1Fp = await fingerprint(formatEd25519PublicKey(claw.device.publicKey));
  const second = await generateEd25519Signer();
  const secondPeer = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const secondCert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(second.publicKey),
      peer_keys: [secondPeer],
      label: "second",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: 1,
    },
    claw.device,
  );
  const secondFp = await fingerprint(secondCert.body.device_pub);
  const revokedFp = await fingerprint(
    formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
  );
  const goneCert = { ...secondCert, body: { ...secondCert.body, label: "gone" } };
  const member = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const legacy = {
    ...current,
    revocations: [],
    binding: { ...current.binding!, chain: [] },
    authority: {
      ...state,
      revoked: [revokedFp],
      owner_devices: {
        [d1Fp]: { cert: { ...state.owner_devices[d1Fp]!.cert, chain: [] }, chain_fps: [d1Fp] },
        [secondFp]: { cert: { ...secondCert, chain: [] }, chain_fps: [secondFp, d1Fp] },
        ["fp:" + "0".repeat(64)]: { cert: { ...goneCert, chain: [] }, chain_fps: [revokedFp] },
      },
      members: { acct_bob: { role: "viewer", peer_keys: [member] } },
    },
    discovery: { ...current.discovery, published_revocations: 0 },
  } as unknown as StoredClaw;
  return { legacy, d1Fp, secondFp, member };
}

describe("allowlist upgrade", () => {
  it("rewrites a pre-allowlist record once, on load", async () => {
    const { legacy, d1Fp, secondFp, member } = await legacyRecord();
    expect(needsAllowlistUpgrade(legacy)).toBe(true);
    const store = memoryStore();
    await store.write(legacy);
    const authority = createOpenClawIdAuthority(store);
    const upgraded = (await authority.load())!;
    expect(needsAllowlistUpgrade(upgraded)).toBe(false);
    expect(upgraded).not.toHaveProperty("revocations");
    expect(upgraded.discovery).not.toHaveProperty("published_revocations");
    expect(upgraded.discovery.publish_pending).toBe(true);
    expect(upgraded.binding).not.toHaveProperty("chain");
    expect(upgraded.authority).not.toHaveProperty("revoked");
    expect(Object.keys(upgraded.authority!.owner_devices).toSorted()).toEqual(
      [d1Fp, secondFp].toSorted(),
    );
    expect(upgraded.authority!.owner_devices[d1Fp]).toMatchObject({ approved_by: "root" });
    expect(upgraded.authority!.owner_devices[secondFp]).toMatchObject({ approved_by: d1Fp });
    expect(upgraded.authority!.owner_devices[secondFp]!.cert).not.toHaveProperty("chain");
    expect(upgraded.authority!.members.acct_bob!.last_seen[member]).toBeTypeOf("number");
    expect(await store.read()).toEqual(upgraded);
  });

  it("gives allowlist records without granted caps the caps of their stored certificate", async () => {
    const claw = await linkedClaw();
    const current = claw.authority.current()!;
    const state = current.authority!;
    const d1Fp = await fingerprint(formatEd25519PublicKey(claw.device.publicKey));
    const { caps: _caps, ...device } = state.owner_devices[d1Fp]!;
    const older = {
      ...current,
      authority: { ...state, owner_devices: { [d1Fp]: device } },
      discovery: { ...current.discovery, publish_pending: false },
    } as unknown as StoredClaw;
    expect(needsAllowlistUpgrade(older)).toBe(true);
    const store = memoryStore();
    await store.write(older);
    const upgraded = (await createOpenClawIdAuthority(store).load())!;
    expect(upgraded.authority!.owner_devices[d1Fp]!.caps).toEqual(device.cert.body.caps);
    expect(upgraded.authority!.owner_devices[d1Fp]!.approved_by).toBe(device.approved_by);
    expect(upgraded.discovery.publish_pending).toBe(true);
    expect(needsAllowlistUpgrade(upgraded)).toBe(false);
  });

  it("upgrades pre-node authority before reconnect and snapshot publication", async () => {
    const claw = await linkedClaw();
    const current = claw.authority.current()!;
    const { nodes: _nodes, node_invites: _invites, ...state } = current.authority!;
    // Persisted before node enrollment added these unsigned collections.
    const older = { ...current, authority: state } as StoredClaw;
    const store = memoryStore();
    await store.write(older);
    const authority = createOpenClawIdAuthority(store);
    expect(await authority.resolvePeer(claw.w1)).toMatchObject({ kind: "owner" });
    const upgraded = authority.current()!;
    expect(upgraded.authority).toEqual({ ...state, nodes: {}, node_invites: {} });
    expect(upgraded.binding).toEqual(current.binding);
    expect(upgraded.discovery.publish_pending).toBe(true);
    expect(
      snapshotBody(upgraded.authority!, current.binding!.body.binding_seq, nowSeconds())
        .node_peer_keys,
    ).toEqual([]);
    expect(await store.read()).toEqual(upgraded);
    expect(await createOpenClawIdAuthority(store).load()).toEqual(upgraded);
  });

  it("leaves a current record alone", async () => {
    const claw = await linkedClaw();
    expect(needsAllowlistUpgrade(claw.authority.current()!)).toBe(false);
  });
});
