import { describe, expect, it } from "vitest";
import {
  encodeKit,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateKitSecret,
  deriveRootSigner,
  randomBytes,
  verifyOwnerStatement,
  ROOT_EPOCH,
  type IrohEndpointKey,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { signRebind, type RebindPreparation } from "./id-cli-rebind.js";
import { describeKeysState } from "./id-cli.js";

async function preparation(rootSecret: Uint8Array): Promise<RebindPreparation> {
  const key = () => formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const gw = () => formatEd25519PublicKey(randomBytes(32));
  return {
    claw_id: "c".repeat(32),
    hostname: "studio-k7x2q.claws.example.test",
    root_pub: formatEd25519PublicKey((await deriveRootSigner(rootSecret)).publicKey),
    k_srv: key(),
    k_gw: gw(),
    binding_seq: 2,
    root_epoch: ROOT_EPOCH,
    current: { k_srv: key(), k_gw: gw(), binding_seq: 1 },
  };
}

describe("openclaw id rebind signing", () => {
  it("signs the prepared binding with the root derived from the kit", async () => {
    const secret = generateKitSecret();
    const prep = await preparation(secret);
    const signed = await signRebind(prep, `  ${await encodeKit(secret)}\n`);
    if (!signed.ok) {
      throw new Error("refused");
    }
    expect(signed.binding.body).toMatchObject({
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: 2,
    });
    expect(await verifyOwnerStatement(signed.binding, { root_pub: prep.root_pub })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a kit for another claw and signs nothing", async () => {
    const prep = await preparation(generateKitSecret());
    expect(await signRebind(prep, await encodeKit(generateKitSecret()))).toMatchObject({
      ok: false,
      code: "wrong_kit",
      kitRoot: expect.stringMatching(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/),
    });
  });

  it("explains refused keys with the fix", () => {
    expect(describeKeysState({ state: "keys_refused", reason: "keys_missing" })).toContain(
      "openclaw id rebind",
    );
    expect(describeKeysState({ state: "keys_refused", reason: "key_mismatch" })).toContain(
      "Restore the original key file",
    );
    expect(describeKeysState({ state: "on" })).toBe("Remote access: on");
  });
});
