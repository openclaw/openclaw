// Publishes the claw descriptor and K_gw-signed membership snapshots to the
// Discovery mirror. Discovery stores them; clients verify them against their
// own pins, so a failed or withheld publication never changes who has access.
import {
  signStatement,
  snapshotBody,
  type ClawDescriptor,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import type { DiscoveryClient } from "./discovery-client.js";

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
  try {
    if (!ownerAccountId) {
      if (!params.enrollmentCode) {
        return { state: "needs_enrollment_code" };
      }
      ownerAccountId = (await params.client.registerClaw(params.enrollmentCode, descriptor))
        .owner_account_id;
    } else {
      await params.client.publishDescriptor(descriptor);
    }
  } catch (error) {
    descriptorFailure = failure(error);
    // Without this binding at Discovery, a snapshot signed for it would be refused.
    if (!ownerAccountId || params.record.discovery.published_binding_seq !== bindingSeq) {
      return descriptorFailure;
    }
  }
  try {
    const snapshot = await signStatement(
      "MembershipSnapshot",
      snapshotBody(state, bindingSeq, now),
      params.signer,
    );
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
