import { describe, expect, it } from "vitest";
import {
  decodeKit,
  deriveRootSigner,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  randomBytes,
  verifyOwnerStatement,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { createOpenClawIdCeremony, type OpenClawIdLinkPreparation } from "./link.ts";

const prep: OpenClawIdLinkPreparation = {
  claw_id: "0123456789abcdef0123456789abcdef",
  hostname: "0123456789abcdef0123456789abcdef.claws.example.test",
  k_srv: formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey,
  k_gw: formatEd25519PublicKey(randomBytes(32)) as Ed25519PublicKey,
  binding_seq: 1,
  root_epoch: 1,
};

describe("Make reachable ceremony", () => {
  it("creates a kit whose root signs D1's certificate and the binding for this claw", async () => {
    const ceremony = createOpenClawIdCeremony();
    const kit = await ceremony.createKit();
    expect(kit.text).toMatch(/^OCK1-/);
    expect(kit.rootFingerprint).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    // The kit text alone recovers the same root.
    const recovered = await deriveRootSigner(await decodeKit(kit.text));
    expect(formatEd25519PublicKey(recovered.publicKey)).toBe(kit.rootPub);

    const device = await generateEd25519Signer();
    const signed = await ceremony.sign(prep, device, "This browser");
    const anchor = { root_pub: kit.rootPub };
    const now = Math.floor(Date.now() / 1000);
    const binding = await verifyOwnerStatement(signed.binding, anchor, {
      now,
    });
    expect(binding.ok).toBe(true);
    expect(signed.binding.body).toMatchObject({
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: 1,
      root_epoch: 1,
    });
    const change = await verifyOwnerStatement(signed.ownerDevice, anchor, {
      now,
    });
    expect(change.ok).toBe(true);
    expect(signed.ownerDevice.body).toMatchObject({ seq: 1, target: { op: "add_owner_device" } });
  });

  it("gives overlapping kit requests one kit, whose root signs the binding", async () => {
    const ceremony = createOpenClawIdCeremony();
    const [first, second] = await Promise.all([ceremony.createKit(), ceremony.createKit()]);
    expect(second.text).toBe(first.text);
    const recovered = await deriveRootSigner(await decodeKit(second.text));
    const signed = await ceremony.sign(prep, await generateEd25519Signer(), "This browser");
    const anchor = { root_pub: formatEd25519PublicKey(recovered.publicKey) };
    const now = Math.floor(Date.now() / 1000);
    expect((await verifyOwnerStatement(signed.binding, anchor, { now })).ok).toBe(true);
  });

  it("cannot sign after the root is discarded", async () => {
    const ceremony = createOpenClawIdCeremony();
    await ceremony.createKit();
    ceremony.discard();
    await expect(ceremony.sign(prep, await generateEd25519Signer(), "x")).rejects.toThrow(
      "create the recovery kit first",
    );
  });
});
