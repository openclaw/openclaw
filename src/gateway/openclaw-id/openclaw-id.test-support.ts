// Shared fixtures for Gateway OpenClaw ID tests: an in-memory claw record and a
// linked claw with root R pinned and owner device D1 (tunnel key W1) admitted.
import { expect, vi } from "vitest";
import {
  computeRedemptionProof,
  deriveInviteProofKey,
  deriveRootSigner,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateInviteSecret,
  generateKitSecret,
  inviteSecretHash,
  OWNER_CAPABILITIES,
  ROOT_EPOCH,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
  type MailboxMessage,
  type MembershipTarget,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { serializePluginStoreJson } from "../../plugin-state/plugin-store-validation.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { StoredClaw } from "./claw-store.js";
import type { OpenClawIdMemberProfiles } from "./member-profiles.js";
import { createOpenClawIdService, type OpenClawIdEffects } from "./service.js";

export const TEST_K_SRV = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A claw record store kept in memory. */
export function memoryStore() {
  let record: StoredClaw | undefined;
  const profiles = new Map<string, Awaited<ReturnType<OpenClawIdMemberProfiles["read"]>>[string]>();
  return {
    profiles: {
      save: async (input: { accountId: string; name?: string | null; email?: string | null }) => {
        const previous = profiles.get(input.accountId);
        profiles.set(input.accountId, {
          id: previous?.id ?? `profile:${input.accountId}`,
          displayName: previous?.displayName ?? input.name ?? null,
          email: input.email ?? previous?.email ?? null,
        });
      },
      read: async (accountIds: readonly string[]) =>
        Object.fromEntries(
          accountIds.flatMap((id) => {
            const profile = profiles.get(id);
            return profile ? [[id, profile]] : [];
          }),
        ),
    },
    read: async () => record,
    write: async (next: StoredClaw) => {
      // Match the durable store's strict JSON contract, including absent optional fields.
      serializePluginStoreJson({
        value: next,
        label: "plugin state value",
        errors: {
          invalid: (message) => new Error(message),
          limit: (message) => new Error(message),
        },
      });
      record = structuredClone(next);
    },
  };
}

/** A linked claw and helpers that sign as owner device D1. */
export async function linkedClaw(
  store: {
    read: () => Promise<StoredClaw | undefined>;
    write: (record: StoredClaw) => Promise<void>;
    profiles?: OpenClawIdMemberProfiles;
  } = memoryStore(),
) {
  const authority = createOpenClawIdAuthority(store);
  const kGw = formatEd25519PublicKey((await generateEd25519Signer()).publicKey);
  const prep = await authority.prepareLink({
    kSrv: TEST_K_SRV,
    kGw,
    hostname: "studio-k7x2q.claws.example.test",
  });
  if ("ok" in prep) {
    throw new Error(prep.detail);
  }
  const root = await deriveRootSigner(generateKitSecret());
  const device = await generateEd25519Signer();
  const w1 = formatIrohEndpointKey(randomBytes(32));
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [w1],
      label: "phone",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: ROOT_EPOCH,
    },
    root,
  );
  const change = await signStatement(
    "MembershipChange",
    {
      claw_id: prep.claw_id,
      seq: 1,
      target: { op: "add_owner_device", cert },
      issued_at: nowSeconds(),
    },
    root,
  );
  const binding = await signStatement("ServerBinding", { ...prep, issued_at: nowSeconds() }, root);
  const linked = await authority.commitLink(
    { root_pub: formatEd25519PublicKey(root.publicKey), owner_device: change, binding },
    "local_operator",
    { kSrv: TEST_K_SRV, kGw },
  );
  expect(linked.ok).toBe(true);
  const seq = async () => (await authority.load())?.authority?.seq ?? 0;
  // Signs a MembershipChange at the next seq, as D1 unless told otherwise.
  const sign = async (target: MembershipTarget, signer: StatementSigner = device) =>
    signStatement(
      "MembershipChange",
      { claw_id: prep.claw_id, seq: (await seq()) + 1, target, issued_at: nowSeconds() },
      signer,
    );
  return { authority, store, cert, device, root, w1, prep, sign, clawId: prep.claw_id };
}

export type LinkedClaw = Awaited<ReturnType<typeof linkedClaw>>;

/** An OpenClaw ID service over a linked claw with recorded side effects. */
export function serviceFor(
  authority: LinkedClaw["authority"],
  config: GatewayOpenClawIdConfig = { enabled: true },
) {
  const effects: OpenClawIdEffects = {
    captureConnections: vi.fn((keys: readonly string[]) =>
      keys.map((key) => `conn-${key.slice(5, 9)}`),
    ),
    cancelRuns: vi.fn(async (connections: readonly string[]) => connections.length),
    closeConnections: vi.fn(),
    revokeDeviceTokens: vi.fn(async (tokens) => [...tokens]),
    describeActivity: vi.fn((keys: readonly string[]) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          {
            connections: 1,
            lastSeenAt: 1_700_000_000_000,
            runs: [{ runId: "r1", sessionKey: "s1" }],
          },
        ]),
      ),
    ),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createOpenClawIdService({
    getConfig: () => config,
    getStateDir: () => "/nonexistent/openclaw-id-test",
    getGatewayServer: () => undefined,
    log,
    createAuthority: async () => authority,
  });
  service.bindEffects(async () => effects);
  return { service, effects, log };
}

/** An InviteCap signed by D1 for `email`, with its proof key and link secret. */
export async function ownerInvite(
  claw: LinkedClaw,
  params: { email: string; role?: "operator" | "viewer"; expiresIn?: number },
) {
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signStatement(
    "InviteCap",
    {
      claw_id: claw.clawId,
      invite_id,
      role: params.role ?? "operator",
      audience: { kind: "email", value: params.email },
      label: params.email,
      created_at: nowSeconds(),
      expires_at: nowSeconds() + (params.expiresIn ?? 7 * 86400),
      single_use: true,
      secret_hash: await inviteSecretHash(proofKey),
    },
    claw.device,
  );
  return { inviteId: invite_id, secret, proofKey, cap };
}

/** The invitee's mailbox message redeeming an invite (as Discovery delivers it). */
export async function redemptionMail(params: {
  clawId: string;
  inviteId: string;
  proofKey: Uint8Array;
  accountId: string;
  email: string;
}) {
  const signer = await generateEd25519Signer();
  const peerKey = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  const parts = {
    claw_id: params.clawId,
    invite_id: params.inviteId,
    account_id: params.accountId,
    device_pub: formatEd25519PublicKey(signer.publicKey),
    peer_key: peerKey,
  };
  const redemption = await signStatement(
    "InviteRedemption",
    {
      ...parts,
      proof: await computeRedemptionProof(params.proofKey, parts),
      requested_at: nowSeconds(),
    },
    signer,
  );
  return {
    peerKey,
    message: {
      message_id: `m-${params.inviteId.slice(0, 6)}`,
      claw_id: params.clawId,
      to: "gateway",
      from: {
        account_id: params.accountId,
        email: params.email,
        display_name: "Bob",
        device_fp: null,
        reported_by: "openclaw-id",
      },
      location_hint: "Lisbon, PT",
      payload: { kind: "invite_redemption", redemption },
      received_at: nowSeconds(),
      expires_at: nowSeconds() + 86400,
    } satisfies MailboxMessage,
  };
}
