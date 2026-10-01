import { isDeepStrictEqual } from "node:util";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ConversationRef, SessionBindingRecord } from "./session-binding.types.js";

/** Exact canonical tuple equality: never normalize an observation into another owner. */
function matchesBindingConversation(
  expected: Readonly<ConversationRef>,
  current: Readonly<ConversationRef>,
): boolean {
  return (
    expected.channel === current.channel &&
    expected.accountId === current.accountId &&
    expected.conversationId === current.conversationId &&
    expected.parentConversationId === current.parentConversationId
  );
}

/** Routing identity only. boundAt is an observation, NOT an ABA-safe generation. */
export function matchesSessionBindingIdentity(
  expected: Readonly<
    Pick<
      SessionBindingRecord,
      "bindingId" | "generation" | "boundAt" | "targetSessionKey" | "targetKind" | "conversation"
    >
  >,
  current: SessionBindingRecord | null,
): boolean {
  return (
    current !== null &&
    expected.bindingId === current.bindingId &&
    typeof expected.generation === "string" &&
    expected.generation.length > 0 &&
    expected.generation === current.generation &&
    expected.boundAt === current.boundAt &&
    expected.targetSessionKey === current.targetSessionKey &&
    expected.targetKind === current.targetKind &&
    matchesBindingConversation(expected.conversation, current.conversation)
  );
}

/** Replay follows the same live route generation through ordinary activity touches. */
export function matchesActiveSessionBindingRoute(
  expected: SessionBindingRecord,
  current: SessionBindingRecord | null,
  now: number,
): boolean {
  const nowMs = asDateTimestampMs(now);
  const boundAt = current ? asDateTimestampMs(current.boundAt) : undefined;
  if (
    nowMs === undefined ||
    boundAt === undefined ||
    boundAt > nowMs ||
    expected.status !== "active" ||
    current?.status !== "active" ||
    !matchesSessionBindingIdentity(expected, current)
  ) {
    return false;
  }
  if (current.expiresAt !== undefined) {
    const expiresAt = asDateTimestampMs(current.expiresAt);
    if (expiresAt === undefined || expiresAt <= nowMs) {
      return false;
    }
  }
  return true;
}

/**
 * Compare-only prerequisite for the native owner, NOT restore authorization.
 * Conservatively rejects lifetime/activity changes instead of refreshing them.
 * Session deletion/reset, binding ABA and default-route changes require lifecycle
 * owners not represented by this record. A true result grants no mutation right.
 */
export function matchesActiveSessionBindingSnapshot(
  expected: SessionBindingRecord,
  current: SessionBindingRecord | null,
  now: number,
): boolean {
  const nowMs = asDateTimestampMs(now);
  const boundAt = asDateTimestampMs(expected.boundAt);
  if (
    nowMs === undefined ||
    boundAt === undefined ||
    boundAt > nowMs ||
    expected.status !== "active" ||
    current?.status !== "active" ||
    !matchesSessionBindingIdentity(expected, current)
  ) {
    return false;
  }
  if (expected.expiresAt !== undefined) {
    const expiresAt = asDateTimestampMs(expected.expiresAt);
    if (expiresAt === undefined || expiresAt <= nowMs) {
      return false;
    }
  }
  return isDeepStrictEqual(expected, current);
}
