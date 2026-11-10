import { describe, expect, it } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { linkedClaw, nowSeconds, TEST_K_SRV } from "./openclaw-id.test-support.js";
import type { RebindPreparation } from "./rebind-operations.js";

async function staged() {
  return {
    kSrv: formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey,
    kGw: formatEd25519PublicKey((await generateEd25519Signer()).publicKey),
  };
}

// The ServerBinding a prepare asks for, signed by `signer` (R unless told otherwise).
async function signPrepared(prep: RebindPreparation, signer: Parameters<typeof signStatement>[2]) {
  const { current: _current, root_pub: _root, ...body } = prep;
  return signStatement("ServerBinding", { ...body, issued_at: nowSeconds() }, signer);
}

describe("re-bind at the authority", () => {
  it("prepares the next binding_seq for the staged keys and commits nothing", async () => {
    const claw = await linkedClaw();
    const keys = await staged();
    const before = claw.authority.current();
    const prep = await claw.authority.prepareRebind(keys);
    expect(prep).toMatchObject({
      claw_id: claw.clawId,
      hostname: claw.prep.hostname,
      k_srv: keys.kSrv,
      k_gw: keys.kGw,
      binding_seq: 2,
      current: { k_srv: TEST_K_SRV, k_gw: claw.prep.k_gw, binding_seq: 1 },
    });
    expect(claw.authority.current()).toBe(before);
  });

  it("stores an R-signed binding for the staged keys and keeps everyone", async () => {
    const claw = await linkedClaw();
    const keys = await staged();
    const people = claw.authority.current()!.authority;
    const prep = (await claw.authority.prepareRebind(keys)) as RebindPreparation;
    const result = await claw.authority.commitRebind(
      await signPrepared(prep, claw.root),
      "local_operator",
      keys,
    );
    expect(result).toMatchObject({ ok: true, bindingSeq: 2 });
    const record = claw.authority.current()!;
    expect(record.binding?.body).toMatchObject({
      binding_seq: 2,
      k_srv: keys.kSrv,
      k_gw: keys.kGw,
    });
    // Owner devices, members, invites, nodes and the membership seq stay.
    expect(record.authority).toEqual(people);
  });

  it.each([
    ["over the tunnel", "not_local_operator"],
    ["signed by an owner device", "wrong_signer"],
    ["for other keys", "target_mismatch"],
    ["replacing one key only", "target_mismatch"],
  ] as const)("refuses a commit %s (%s)", async (variant, code) => {
    const claw = await linkedClaw();
    const keys = await staged();
    const prep = (await claw.authority.prepareRebind(keys)) as RebindPreparation;
    const signed = await signPrepared(
      prep,
      variant === "signed by an owner device" ? claw.device : claw.root,
    );
    const expected =
      variant === "for other keys"
        ? await staged()
        : variant === "replacing one key only"
          ? { ...keys, kGw: claw.prep.k_gw }
          : keys;
    const before = claw.authority.current();
    const result = await claw.authority.commitRebind(
      signed,
      variant === "over the tunnel" ? "tunnel" : "local_operator",
      expected,
    );
    expect(result).toMatchObject({ ok: false, code });
    expect(claw.authority.current()).toBe(before);
  });

  it("refuses a second commit of the same binding once it is stored", async () => {
    const claw = await linkedClaw();
    const keys = await staged();
    const prep = (await claw.authority.prepareRebind(keys)) as RebindPreparation;
    const signed = await signPrepared(prep, claw.root);
    expect(await claw.authority.commitRebind(signed, "local_operator", keys)).toMatchObject({
      ok: true,
    });
    // Now the staged keys are the bound ones, so this would not replace both keys.
    expect(await claw.authority.commitRebind(signed, "local_operator", keys)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
  });

  it("refuses a prepare that keeps a bound key", async () => {
    const claw = await linkedClaw();
    expect(
      await claw.authority.prepareRebind({ kSrv: TEST_K_SRV, kGw: (await staged()).kGw }),
    ).toMatchObject({ ok: false, code: "target_mismatch" });
  });
});
