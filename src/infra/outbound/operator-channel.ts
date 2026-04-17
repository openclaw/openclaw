// Operator-visibility channel resolution.
//
// Phase 4 of the Discord Surface Overhaul introduced the concept of an
// operator-only channel: a surface that receives boot/resume/cron
// operator-only signals instead of posting them onto user-facing Discord
// threads. This helper centralizes lookup so every call site (delivery gate,
// cron reroute, restart sentinel, etc.) sees the same resolution semantics.
//
// Returning `undefined` means "no operator channel configured"; callers MUST
// treat that as "suppress the operator-only signal" rather than falling back
// to a user-facing channel.

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedSurfaceTarget } from "./surface-policy.js";

export function resolveOperatorChannel(
  cfg: OpenClawConfig | undefined,
): ResolvedSurfaceTarget | undefined {
  const operator = cfg?.channels?.operator;
  if (!operator) {
    return undefined;
  }
  const channel = typeof operator.channel === "string" ? operator.channel.trim() : "";
  const to = typeof operator.to === "string" ? operator.to.trim() : "";
  if (!channel || !to) {
    return undefined;
  }
  const accountId =
    typeof operator.accountId === "string" && operator.accountId.trim()
      ? operator.accountId.trim()
      : undefined;
  const threadId =
    typeof operator.threadId === "string" || typeof operator.threadId === "number"
      ? operator.threadId
      : undefined;
  return {
    channel,
    to,
    accountId,
    threadId,
  };
}
