import type { StateLeaseLoss } from "./state-lease-loss.js";

/** Browser-safe projection; validation stays with the canonical lease-loss schema. */
export function formatStateLeaseLoss(loss: StateLeaseLoss): string {
  if (loss.reason === "expired") {
    return `lease loss: expired; expiredByMs=${loss.expiredByMs}; expiresAt=${loss.expiresAt}; heartbeatAgeMs=${loss.heartbeatAgeMs}${loss.renewalTimerLateByMs === undefined ? "" : `; renewal timer late ${loss.renewalTimerLateByMs} ms`}`;
  }
  return loss.reason === "replaced"
    ? "lease loss: replaced; owner=[redacted]"
    : "lease loss: missing";
}
