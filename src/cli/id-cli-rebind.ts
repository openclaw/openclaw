// `openclaw id rebind`: moves this claw to new machine keys with its recovery kit
// (OpenClaw ID re-bind, enrollment.md "Re-bind"). The Gateway stages the keys and
// stores the binding; the owner root R is derived here, from the kit typed on this
// machine, signs the binding and is dropped. The kit never reaches the Gateway or argv.
import {
  decodeKit,
  deriveRootSigner,
  displayFingerprint,
  fingerprint,
  formatEd25519PublicKey,
  parseClawDescriptor,
  verifyBindingForPin,
  signStatement,
  type ROOT_EPOCH,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type SignedStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";

/** What `openclawId.authority { action: "rebind_prepare" }` returns. */
export type RebindPreparation = {
  claw_id: string;
  hostname: string;
  root_pub: Ed25519PublicKey;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: number;
  root_epoch: typeof ROOT_EPOCH;
  current: { k_srv: IrohEndpointKey; k_gw: Ed25519PublicKey; binding_seq: number };
  /** Discovery's published descriptor (untrusted), or why it could not be read. */
  published: { descriptor: unknown } | { error: string; detail: string };
};

/** Why the CLI signs nothing. */
export type RebindSignRefusal =
  | { ok: false; code: "wrong_kit"; kitRoot: string }
  | { ok: false; code: "published_unverifiable"; detail: string }
  | { ok: false; code: "published_unavailable"; detail: string; atLeast: number }
  | { ok: false; code: "binding_seq_too_low"; atLeast: number };

/**
 * The binding_seq to sign: one above the higher of this machine's binding and the binding
 * Discovery publishes, once that verified under the root (it is higher after a restore from an
 * older backup). Unverifiable published data is refused, never used. `override` replaces the
 * choice when Discovery cannot be read, and must be above every binding known to be verified.
 */
async function chooseBindingSeq(
  prep: RebindPreparation,
  rootPub: Ed25519PublicKey,
  now: number,
  override: number | undefined,
): Promise<{ ok: true; bindingSeq: number } | RebindSignRefusal> {
  let published = 0;
  let unreadable: RebindSignRefusal | undefined;
  if ("descriptor" in prep.published) {
    const parsed = parseClawDescriptor(prep.published.descriptor);
    const checked = parsed.ok
      ? await verifyBindingForPin(
          { root_pub: parsed.descriptor.root_pub, binding: parsed.descriptor.binding },
          { claw_id: prep.claw_id, root_fp: await fingerprint(rootPub), binding_seq: 0 },
          { now, host: prep.hostname },
        )
      : { ok: false as const, code: parsed.code, detail: parsed.detail };
    if (!checked.ok) {
      unreadable = {
        ok: false,
        code: "published_unverifiable",
        detail: `Discovery's published binding does not verify under this kit (${checked.code})`,
      };
    } else {
      published = checked.binding.binding_seq;
    }
  } else if (prep.published.error !== "not_found") {
    unreadable = {
      ok: false,
      code: "published_unavailable",
      detail: prep.published.detail,
      atLeast: prep.current.binding_seq + 1,
    };
  }
  const atLeast = Math.max(prep.current.binding_seq, published) + 1;
  if (override !== undefined) {
    return override >= atLeast
      ? { ok: true, bindingSeq: override }
      : { ok: false, code: "binding_seq_too_low", atLeast };
  }
  return unreadable ?? { ok: true, bindingSeq: atLeast };
}

/** Human-checkable fingerprint of a public key. */
export async function displayKey(key: Ed25519PublicKey | IrohEndpointKey): Promise<string> {
  return displayFingerprint(await fingerprint(key));
}

/**
 * Derives R from the kit and signs the prepared binding. A kit for another claw signs
 * nothing: its root's fingerprint is returned so the operator can tell kits apart.
 */
export async function signRebind(
  prep: RebindPreparation,
  kitText: string,
  options: { bindingSeq?: number; now?: number } = {},
): Promise<{ ok: true; binding: SignedStatement<"ServerBinding"> } | RebindSignRefusal> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const secret = await decodeKit(kitText.trim());
  try {
    const root = await deriveRootSigner(secret);
    const rootPub = formatEd25519PublicKey(root.publicKey);
    if (rootPub !== prep.root_pub) {
      return { ok: false, code: "wrong_kit", kitRoot: await displayKey(rootPub) };
    }
    const seq = await chooseBindingSeq(prep, rootPub, now, options.bindingSeq);
    if (!seq.ok) {
      return seq;
    }
    const binding = await signStatement(
      "ServerBinding",
      {
        claw_id: prep.claw_id,
        hostname: prep.hostname,
        k_srv: prep.k_srv,
        k_gw: prep.k_gw,
        binding_seq: seq.bindingSeq,
        root_epoch: prep.root_epoch,
        issued_at: now,
      },
      root,
    );
    return { ok: true, binding };
  } finally {
    secret.fill(0);
  }
}

/** The confirmation the operator answers before the binding is signed. */
export async function describeRebind(
  prep: RebindPreparation,
  binding: SignedStatement<"ServerBinding">,
): Promise<string> {
  return [
    `Move ${prep.hostname} to new keys?`,
    `  Owner root:   ${await displayKey(prep.root_pub)} (matches your recovery kit)`,
    `  Binding:      ${prep.current.binding_seq} -> ${binding.body.binding_seq}`,
    `  Endpoint key: ${await displayKey(prep.current.k_srv)} -> ${await displayKey(prep.k_srv)}`,
    `  Gateway key:  ${await displayKey(prep.current.k_gw)} -> ${await displayKey(prep.k_gw)}`,
    "Your devices, people, nodes and invites stay. Every connected device disconnects for a",
    "moment and reconnects by itself.",
  ].join("\n");
}
