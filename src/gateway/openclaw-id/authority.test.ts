import { describe, expect, it, vi } from "vitest";
import {
  deriveRootSigner,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateKitSecret,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority, type LinkPreparation } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import { linkedClaw } from "./openclaw-id.test-support.js";

const K_SRV = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;

function memoryStore() {
  let record: StoredClaw | undefined;
  const writes: StoredClaw[] = [];
  return {
    writes,
    read: async () => record,
    write: async (next: StoredClaw) => {
      record = structuredClone(next);
      writes.push(record);
    },
  };
}

// What the Control UI does in "Make reachable": derive R from a fresh kit, create
// owner device D1 and its peer key W1, and sign D1's certificate and the binding.
async function ownerCeremony(prep: LinkPreparation) {
  const root = await deriveRootSigner(generateKitSecret());
  const rootPub = formatEd25519PublicKey(root.publicKey);
  const device = await generateEd25519Signer();
  const peerKey = formatIrohEndpointKey(randomBytes(32));
  const now = Math.floor(Date.now() / 1000);
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [peerKey],
      label: "This browser",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: now,
      expires_at: null,
      root_epoch: 1,
    },
    root,
  );
  const ownerDevice = await signStatement(
    "MembershipChange",
    { claw_id: prep.claw_id, seq: 1, target: { op: "add_owner_device", cert }, issued_at: now },
    root,
  );
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: 1,
      root_epoch: 1,
      issued_at: now,
    },
    root,
  );
  return { rootPub, peerKey, input: { root_pub: rootPub, owner_device: ownerDevice, binding } };
}

async function prepared() {
  const store = memoryStore();
  const authority = createOpenClawIdAuthority(store);
  const kGw = formatEd25519PublicKey((await generateEd25519Signer()).publicKey) as Ed25519PublicKey;
  const prep = await authority.prepareLink({
    kSrv: K_SRV,
    kGw,
    hostname: "studio-k7x2q.claws.example.test",
  });
  if ("ok" in prep) {
    throw new Error(prep.detail);
  }
  return { store, authority, kGw, prep };
}

describe("OpenClaw ID membership authority: linking", () => {
  it("prepares a stable claw id with the hostname Discovery assigned", async () => {
    const { prep, kGw, authority } = await prepared();
    expect(prep.claw_id).toMatch(/^[0-9a-f]{32}$/);
    expect(prep).toMatchObject({
      hostname: "studio-k7x2q.claws.example.test",
      k_srv: K_SRV,
      k_gw: kGw,
      binding_seq: 1,
      root_epoch: 1,
    });
    const again = await authority.prepareLink({
      kSrv: K_SRV,
      kGw,
      hostname: "studio-k7x2q.claws.example.test",
    });
    expect(again).toMatchObject({ claw_id: prep.claw_id });
  });

  it("pins the owner root, admits owner device D1 and stores the binding over direct loopback", async () => {
    const { authority, kGw, prep, store } = await prepared();
    const ceremony = await ownerCeremony(prep);
    const result = await authority.commitLink(ceremony.input, "local_operator", {
      kSrv: K_SRV,
      kGw,
    });
    expect(result).toMatchObject({ ok: true, status: "applied" });
    const record = store.writes.at(-1)!;
    expect(record.authority?.anchor).toEqual({ root_pub: ceremony.rootPub });
    expect(record.authority?.seq).toBe(1);
    expect(record.binding?.body.k_srv).toBe(K_SRV);
    expect(await authority.admittedPeerKeys()).toEqual({ seq: 1, admitted: [ceremony.peerKey] });
    // Nothing secret about R is stored: only its public key.
    expect(JSON.stringify(record)).not.toMatch(/seed|kit|OCK1/i);
  });

  // Spec section 11 #7: relayed traffic tries a root ceremony and is refused.
  it.each(["tunnel", "mailbox", undefined] as const)("refuses to link over %s", async (channel) => {
    const { authority, kGw, prep, store } = await prepared();
    const writes = store.writes.length;
    const result = await authority.commitLink((await ownerCeremony(prep)).input, channel, {
      kSrv: K_SRV,
      kGw,
    });
    expect(result).toMatchObject({ ok: false, code: "not_local_operator" });
    expect(store.writes).toHaveLength(writes);
    expect(await authority.admittedPeerKeys()).toEqual({ seq: 0, admitted: [] });
  });

  it("refuses a binding for another server key and links nothing", async () => {
    const { authority, kGw, prep } = await prepared();
    const ceremony = await ownerCeremony({
      ...prep,
      k_srv: formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey,
    });
    const result = await authority.commitLink(ceremony.input, "local_operator", {
      kSrv: K_SRV,
      kGw,
    });
    expect(result).toMatchObject({ ok: false, code: "target_mismatch" });
    expect(authority.current()?.authority).toBeNull();
  });

  it("refuses a second link once the root is pinned", async () => {
    const { authority, kGw, prep } = await prepared();
    await authority.commitLink((await ownerCeremony(prep)).input, "local_operator", {
      kSrv: K_SRV,
      kGw,
    });
    const second = await authority.commitLink((await ownerCeremony(prep)).input, "local_operator", {
      kSrv: K_SRV,
      kGw,
    });
    expect(second).toMatchObject({ ok: false, code: "already_linked" });
    expect(
      await authority.prepareLink({ kSrv: K_SRV, kGw, hostname: "other-k7x2q.x.test" }),
    ).toMatchObject({
      ok: false,
      code: "already_linked",
    });
  });

  it("shares the first read, so a late initial load cannot undo a committed write", async () => {
    const backing = (await linkedClaw()).store;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async () => {
      await gate;
      return await backing.read();
    });
    const authority = createOpenClawIdAuthority({ read, write: backing.write });
    const first = authority.load();
    const written = authority.recordDiscovery({ mailbox_cursor: "after-load" });
    const second = authority.load();
    release();
    await Promise.all([first, written, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await authority.load())?.discovery.mailbox_cursor).toBe("after-load");
  });
});
