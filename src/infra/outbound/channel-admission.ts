// Per-channel echo-delivery admission. The prompt/post-hoc echo path
// (fireEchoDeliveries) delivers to pinned targets via the channel-agnostic raw
// send, which bypasses each channel's own inbound admission gate. Without this,
// a pinned destination keeps receiving echoes after its group/topic is disabled
// (revocation), because only the native mirror path runs the channel gate. A
// channel registers an admission predicate so echo deliveries honor the live
// enablement of the destination too.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isChannelMirrorCapable } from "./channel-mirror-capability.js";

export type EchoAdmissionTarget = {
  to: string;
  accountId?: string;
  threadId?: string | number;
};

/**
 * Returns false when an echo delivery to this target is currently not allowed.
 * May be async — telegram re-checks DM pairing/allowlist authorization, which is
 * resolved through the ingress resolver.
 */
export type ChannelEchoAdmission = (
  cfg: OpenClawConfig,
  target: EchoAdmissionTarget,
) => boolean | Promise<boolean>;

const admissions = new Map<string, Map<string, ChannelEchoAdmission>>();

function normalizeAdmissionAccountId(accountId: string | undefined): string {
  return accountId && accountId.trim() ? accountId : "";
}

/** Register the echo-admission predicate for a channel ACCOUNT (last-wins, like the
 * mirror dispatcher, so an account reload supersedes a stale closure). */
export function registerChannelEchoAdmission(
  channel: string,
  accountId: string,
  admission: ChannelEchoAdmission,
): void {
  let byAccount = admissions.get(channel);
  if (!byAccount) {
    byAccount = new Map<string, ChannelEchoAdmission>();
    admissions.set(channel, byAccount);
  }
  byAccount.set(normalizeAdmissionAccountId(accountId), admission);
}

/** Remove a channel account's echo-admission predicate (account stopped). No-op if absent. */
export function unregisterChannelEchoAdmission(channel: string, accountId: string): void {
  const byAccount = admissions.get(channel);
  if (!byAccount) {
    return;
  }
  byAccount.delete(normalizeAdmissionAccountId(accountId));
  if (byAccount.size === 0) {
    admissions.delete(channel);
  }
}

function resolveChannelEchoAdmission(
  channel: string,
  accountId: string | undefined,
): ChannelEchoAdmission | undefined {
  const byAccount = admissions.get(channel);
  if (!byAccount || byAccount.size === 0) {
    return undefined;
  }
  const key = normalizeAdmissionAccountId(accountId);
  const exact = byAccount.get(key);
  if (exact) {
    return exact;
  }
  // Sole-predicate fallback only for a wildcard target (no pinned account).
  if (key === "" && byAccount.size === 1) {
    return [...byAccount.values()][0];
  }
  return undefined;
}

/**
 * Whether an echo/post-hoc delivery to this target is currently allowed. A channel
 * that registers a predicate gates echo deliveries on the destination's live
 * enablement, so a pinned target stops receiving echoes once its group/topic is
 * disabled. Fail closed: if a channel has predicates registered but none resolves
 * for the target's account, deny (never echo through an unverified account).
 * Channels with no predicate registered deliver as before (return true).
 */
export async function isEchoTargetAdmissible(
  cfg: OpenClawConfig,
  channel: string,
  target: EchoAdmissionTarget,
): Promise<boolean> {
  const byAccount = admissions.get(channel);
  if (!byAccount || byAccount.size === 0) {
    // No predicate registered for this channel. A mirror-capable channel
    // (telegram) must FAIL CLOSED here: an account stop/reload unregisters its
    // admission predicate (and mirror dispatcher) together, and admitting during
    // that window would let the raw echo leak to a now-revoked destination.
    // Channels that never register a mirror dispatcher admit echoes as before.
    return !isChannelMirrorCapable(channel);
  }
  const admission = resolveChannelEchoAdmission(channel, target.accountId);
  if (!admission) {
    return false;
  }
  return await admission(cfg, target);
}

export function resetChannelEchoAdmissionForTest(): void {
  admissions.clear();
}
