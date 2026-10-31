// "Make reachable" ceremony in the browser (owner-key spec section 4). The
// kit secret S and owner root R exist only inside this module while the dialog
// is open; the Gateway receives public keys and signed statements only.
import {
  deriveRootSigner,
  displayFingerprint,
  encodeKit,
  fingerprint,
  formatEd25519PublicKey,
  generateKitSecret,
  OWNER_CAPABILITIES,
  signOwnerKeyRegeneration,
  signStatement,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  type OwnerKeyRegenerationPreparation,
  type OwnerKeyRegenerationStatements,
  type SignedStatement,
  type StatementSigner,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";

/** What the Gateway asks the owner root to sign (`openclawId.authority` prepare). */
export type OpenClawIdLinkPreparation = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: 1;
  root_epoch: 1;
};

/** A freshly generated recovery kit, shown once. */
export type OpenClawIdKit = {
  /** `OCK1-...` text the owner saves. */
  text: string;
  /** fp(R) in 4x5 Crockford groups, printed on the kit and pinned by the Gateway. */
  rootFingerprint: string;
  rootPub: Ed25519PublicKey;
};

/** The signed result sent to `openclawId.authority` commit. */
export type OpenClawIdLinkStatements = {
  rootPub: Ed25519PublicKey;
  ownerDevice: SignedStatement<"MembershipChange">;
  binding: SignedStatement<"ServerBinding">;
};

/** Holds S and R for one dialog; `discard` drops them. */
export function createOpenClawIdCeremony() {
  let secret: Uint8Array | undefined;
  let root: StatementSigner | undefined;

  return {
    /** Generates S, derives R and returns the kit to show. */
    async createKit(): Promise<OpenClawIdKit> {
      secret = generateKitSecret();
      root = await deriveRootSigner(secret);
      const rootPub = formatEd25519PublicKey(root.publicKey);
      return {
        text: await encodeKit(secret),
        rootFingerprint: displayFingerprint(await fingerprint(rootPub)),
        rootPub,
      };
    },

    /**
     * Signs, with R, owner device D1's certificate (as MembershipChange
     * add_owner_device, seq 1) and ServerBinding(seq 1, epoch 1).
     */
    async sign(
      prep: OpenClawIdLinkPreparation,
      device: StatementSigner,
      deviceLabel: string,
    ): Promise<OpenClawIdLinkStatements> {
      if (!root) {
        throw new Error("create the recovery kit first");
      }
      const now = Math.floor(Date.now() / 1000);
      const cert = await signStatement(
        "OwnerDeviceCert",
        {
          device_pub: formatEd25519PublicKey(device.publicKey),
          // This origin reaches the Gateway on loopback; it has no tunnel peer key.
          peer_keys: [],
          label: deviceLabel,
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
          binding_seq: prep.binding_seq,
          root_epoch: prep.root_epoch,
          issued_at: now,
        },
        root,
      );
      return { rootPub: formatEd25519PublicKey(root.publicKey), ownerDevice, binding };
    },

    /**
     * Owner-key regeneration (OCF-319): signs, with the new root R', this browser's
     * certificate for the new epoch (no expiry unless `expiresAt` is given) and the
     * new ServerBinding. Only these public statements go to the Gateway.
     */
    async signRegeneration(
      prep: OwnerKeyRegenerationPreparation,
      device: StatementSigner,
      deviceLabel: string,
      expiresAt: number | null,
    ): Promise<OwnerKeyRegenerationStatements> {
      if (!root) {
        throw new Error("create the recovery kit first");
      }
      return await signOwnerKeyRegeneration({
        preparation: prep,
        root,
        device: {
          device_pub: formatEd25519PublicKey(device.publicKey),
          // This origin reaches the Gateway on loopback; it has no tunnel peer key.
          peer_keys: [],
          label: deviceLabel,
        },
        expiresAt,
      });
    },

    /** Wipes S and drops R (the non-extractable key can only be dereferenced). */
    discard(): void {
      secret?.fill(0);
      secret = undefined;
      root = undefined;
    },
  };
}

/**
 * The OpenClaw ID page that hands the signed-in owner a one-time enrollment
 * code for this claw's loader domain (https://claws.<loaderDomain>/link).
 */
export function linkCodePageUrl(loaderDomain: string): string {
  return `https://claws.${loaderDomain}/link`;
}
