import { describe, expect, it, vi } from "vitest";
import {
  deriveRootSigner,
  encodeKit,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateKitSecret,
  randomBytes,
  ROOT_EPOCH,
  verifyOwnerStatement,
  type IrohEndpointKey,
  type RebindPreparation,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { commitRebind, prepareRebind } from "./rebind.ts";

// mock-isolation: the account sign-in owner is covered by the account menu tests; here the
// link code it hands out is fixed so the re-bind requests can be read exactly.
vi.mock("./account.ts", () => ({ requestOpenClawIdLinkCode: async () => "ACCOUNT-CODE" }));

const signedIn = { sub: "s", email: null, name: null, exp: 4_102_444_800, idToken: "t" };
const key = () => formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
const gw = () => formatEd25519PublicKey(randomBytes(32));

async function claw() {
  const secret = generateKitSecret();
  const root = await deriveRootSigner(secret);
  const prep: RebindPreparation = {
    claw_id: "c".repeat(32),
    hostname: "studio-k7x2q.claws.example.test",
    root_pub: formatEd25519PublicKey(root.publicKey),
    k_srv: key(),
    k_gw: gw(),
    binding_seq: 2,
    root_epoch: ROOT_EPOCH,
    current: { k_srv: key(), k_gw: gw(), binding_seq: 1 },
    published: { error: "not_found", detail: "not registered" },
  };
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    params.action === "rebind_prepare" ? prep : { ok: true, bindingSeq: 2 },
  );
  const client = { request } as unknown as GatewayBrowserClient;
  return { kit: await encodeKit(secret), prep, request, client };
}

describe("Move to new keys in the browser", () => {
  it("signs the staged keys with the kit and commits them with the account's code", async () => {
    const { kit, prep, request, client } = await claw();
    const result = await prepareRebind({ client, signedIn, kitText: kit });
    if (!result.ok) {
      throw new Error(result.code);
    }
    expect(request).toHaveBeenCalledWith("openclawId.authority", {
      action: "rebind_prepare",
      code: "ACCOUNT-CODE",
    });
    const { binding } = result.plan;
    expect(binding.body).toMatchObject({ k_srv: prep.k_srv, k_gw: prep.k_gw, binding_seq: 2 });
    expect(
      await verifyOwnerStatement(binding, { root_pub: prep.root_pub }, { now: Date.now() / 1000 }),
    ).toMatchObject({ ok: true });
    expect(result.plan.bindingSeq).toEqual({ from: 1, to: 2 });
    await commitRebind(client, result.plan);
    expect(request).toHaveBeenLastCalledWith("openclawId.authority", {
      action: "rebind_commit",
      binding,
      code: "ACCOUNT-CODE",
    });
  });

  it("refuses text that is not a recovery code before staging anything", async () => {
    const { request, client } = await claw();
    expect(await prepareRebind({ client, signedIn, kitText: "not a kit" })).toEqual({
      ok: false,
      code: "bad_kit",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("signs nothing with another claw's kit", async () => {
    const { client } = await claw();
    const other = await encodeKit(generateKitSecret());
    expect(await prepareRebind({ client, signedIn, kitText: other })).toMatchObject({
      ok: false,
      code: "wrong_kit",
    });
  });
});
