// Publishes the claw descriptor and K_gw-signed membership snapshots to the
// Discovery mirror. Discovery stores them; clients verify them against their
// own pins, so a failed or withheld publication never changes who has access.
import {
  fingerprint,
  parseStatement,
  signStatement,
  snapshotBody,
  verifyBindingForPin,
  type ClawDescriptor,
  type IrohEndpointKey,
  type Ed25519PublicKey,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { DiscoveryRequestError, type DiscoveryClient } from "./discovery-client.js";

/** Outcome of one publication attempt, shown in status. */
export type PublishOutcome =
  | {
      state: "published";
      ownerAccountId: string | null;
      snapshotSeq: number;
      /** issued_at of the snapshot Discovery accepted. */
      snapshotIssuedAt: number;
      /** When the Gateway re-signs next (epoch ms), if a re-sign is scheduled. */
      refreshAt?: number;
    }
  | { state: "needs_enrollment_code" }
  | {
      state: "failed";
      code: string;
      message: string;
      /** True when the same publication may succeed later (network, 5xx, 409, 429). */
      retryable: boolean;
      /** When the Gateway retries on its own (epoch ms), if a retry is scheduled. */
      retryAt?: number;
      /**
       * Set when this attempt registered the claw before failing: the one-time enrollment
       * code is spent, so the caller must record the account to publish again without it.
       */
      ownerAccountId?: string;
      /** `binding_superseded`: the root-verified binding Discovery publishes instead of ours. */
      superseded?: {
        bindingSeq: number;
        publishedBindingSeq: number;
        kSrv: IrohEndpointKey;
        kGw: Ed25519PublicKey;
      };
    };

// Discovery statuses worth retrying unchanged: concurrent updates, rate limits, outages.
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

/**
 * Classifies a failed Discovery call: no HTTP status (network) or 5xx is transient.
 * `stale_snapshot` skips immediate retries: Discovery already holds a snapshot at
 * least as new. The publication owner still schedules the next regular re-sign.
 */
export function isRetryableDiscoveryError(error: unknown): boolean {
  // SAFETY: error is a thrown value; reading an optional code property of an object is checked by ===.
  if ((error as { code?: unknown }).code === "stale_snapshot") {
    return false;
  }
  // SAFETY: status is checked with typeof before use.
  const status = (error as { status?: unknown }).status;
  if (typeof status !== "number") {
    return true;
  }
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

// A re-bind waits for a (new) one-time code from the owner account: `openclaw id publish --code`.
function needsLinkCode(): Extract<PublishOutcome, { state: "failed" }> {
  return {
    state: "failed",
    code: "needs_link_code",
    message: "publishing the new keys needs a link code from your OpenClaw ID account",
    retryable: false,
  };
}

// The failed outcome for an error thrown by a Discovery call.
function failure(error: unknown): Extract<PublishOutcome, { state: "failed" }> {
  return {
    state: "failed",
    // SAFETY: code is optional and falls back to "unavailable" when absent.
    code: (error as { code?: string }).code ?? "unavailable",
    message: error instanceof Error ? error.message : String(error),
    retryable: isRetryableDiscoveryError(error),
  };
}

/**
 * Discovery refused our binding (`stale_binding`/`conflict`) and named the one it publishes.
 * Verified under the claw's root and naming other keys, this machine is superseded: restored
 * from an older backup, or someone with the recovery kit moved the claw. The remedy is the
 * same, a re-bind above it. A binding that does not verify is an integrity error.
 */
async function supersededBy(
  error: unknown,
  record: StoredClaw,
  now: number,
): Promise<Extract<PublishOutcome, { state: "failed" }> | undefined> {
  if (
    !(error instanceof DiscoveryRequestError) ||
    (error.code !== "stale_binding" && error.code !== "conflict") ||
    error.binding === undefined ||
    !record.authority ||
    !record.binding
  ) {
    return undefined;
  }
  const ours = record.binding.body;
  const root_pub = record.authority.anchor.root_pub;
  const parsed = parseStatement(error.binding, "ServerBinding");
  const checked = parsed.ok
    ? await verifyBindingForPin(
        { root_pub, binding: parsed.statement },
        {
          claw_id: record.claw_id,
          root_fp: await fingerprint(root_pub),
          binding_seq: ours.binding_seq,
        },
        { now, host: ours.hostname },
      )
    : undefined;
  if (!checked?.ok) {
    return {
      state: "failed",
      code: "discovery_integrity",
      message: `Discovery refused this claw's binding (${error.code}) but the binding it publishes does not verify under the claw's root${checked ? ` (${checked.code})` : ""}`,
      retryable: false,
    };
  }
  const theirs = checked.binding;
  if (theirs.k_gw === ours.k_gw && theirs.k_srv === ours.k_srv) {
    return undefined;
  }
  return {
    state: "failed",
    code: "binding_superseded",
    message: `Discovery lists newer keys for this claw (binding ${theirs.binding_seq}) that this computer doesn't have`,
    retryable: false,
    superseded: {
      bindingSeq: ours.binding_seq,
      publishedBindingSeq: theirs.binding_seq,
      kSrv: theirs.k_srv,
      kGw: theirs.k_gw,
    },
  };
}

/** Builds the descriptor for a linked claw. */
function buildDescriptor(
  record: StoredClaw,
  relayUrl: string,
  now: number,
): ClawDescriptor | undefined {
  if (!record.authority || !record.binding) {
    return undefined;
  }
  return {
    v: 1,
    claw_id: record.claw_id,
    transport: "iroh",
    relay_url: relayUrl,
    root_pub: record.authority.anchor.root_pub,
    binding: record.binding,
    published_at: now,
  };
}

/**
 * Registers the claw on first publication (with the owner's one-time enrollment
 * code), otherwise republishes the descriptor, then publishes a fresh snapshot.
 * A failed descriptor republish does not hold back the snapshot when Discovery
 * already has this binding: the snapshot only depends on the published binding,
 * and a stale snapshot is what blocks enrollment. The outcome still reports the
 * descriptor failure, so the caller retries both. Every call signs a new snapshot
 * (same seq, new issued_at: freshness/v1).
 */
export async function publishClaw(params: {
  record: StoredClaw;
  relayUrl: string;
  client: DiscoveryClient;
  signer: StatementSigner;
  /** The owner account's one-time code: registers a new claw, or publishes a re-bind. */
  enrollmentCode?: string;
}): Promise<PublishOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const descriptor = buildDescriptor(params.record, params.relayUrl, now);
  const state = params.record.authority;
  if (!descriptor || !state) {
    return {
      state: "failed",
      code: "not_linked",
      message: "this claw is not linked",
      retryable: false,
    };
  }
  const bindingSeq = descriptor.binding.body.binding_seq;
  let ownerAccountId = params.record.discovery.owner_account_id;
  const registeredBefore = ownerAccountId !== null;
  let descriptorFailure: Extract<PublishOutcome, { state: "failed" }> | undefined;
  const snapshot = await signStatement(
    "MembershipSnapshot",
    snapshotBody(state, bindingSeq, now),
    params.signer,
  );
  // A binding after the first comes from a re-bind (new K_gw): until Discovery confirmed it,
  // it goes out with its snapshot in one write.
  const rebindPending =
    bindingSeq > 1 && params.record.discovery.published_binding_seq < bindingSeq;
  try {
    if (!ownerAccountId) {
      if (!params.enrollmentCode) {
        return { state: "needs_enrollment_code" };
      }
      ownerAccountId = (await params.client.registerClaw(params.enrollmentCode, descriptor))
        .owner_account_id;
    } else if (rebindPending) {
      // Discovery moves the claw to a new K_gw only with the owner account's code (discovery.md).
      if (!params.enrollmentCode) {
        return needsLinkCode();
      }
      await params.client.publishDescriptor(descriptor, { snapshot, code: params.enrollmentCode });
      return { state: "published", ownerAccountId, snapshotSeq: state.seq, snapshotIssuedAt: now };
    } else {
      await params.client.publishDescriptor(descriptor);
    }
  } catch (error) {
    // SAFETY: error is a thrown value; an optional code property is compared with ===.
    if (rebindPending && (error as { code?: unknown }).code === "code_invalid") {
      return needsLinkCode();
    }
    const superseded = await supersededBy(error, params.record, now);
    if (superseded) {
      return superseded;
    }
    descriptorFailure = failure(error);
    // Without this binding at Discovery, a snapshot signed for it would be refused.
    if (!ownerAccountId || params.record.discovery.published_binding_seq !== bindingSeq) {
      return descriptorFailure;
    }
  }
  try {
    await params.client.publishSnapshot(descriptor.claw_id, snapshot);
  } catch (error) {
    const failed = descriptorFailure ?? failure(error);
    return !registeredBefore && ownerAccountId ? { ...failed, ownerAccountId } : failed;
  }
  return (
    descriptorFailure ?? {
      state: "published",
      ownerAccountId,
      snapshotSeq: state.seq,
      snapshotIssuedAt: now,
    }
  );
}
