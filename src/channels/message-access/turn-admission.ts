import type { ChannelTurnAdmission } from "../turn/types.js";
import type { ChannelIngressDecision } from "./types.js";

/** Side effect produced while handling an ingress decision before turn admission is mapped. */
export type ChannelIngressSideEffectResult =
  | { kind: "none" }
  | { kind: "pairing-reply-sent" }
  | { kind: "pairing-reply-failed"; errorCode?: string }
  | { kind: "command-reply-sent" }
  | { kind: "command-reply-failed"; errorCode?: string }
  | { kind: "pending-history-recorded" }
  | { kind: "local-event-handled" };

/** Convert an ingress graph decision plus any plugin-owned side effect into turn admission. */
export function mapChannelIngressDecisionToTurnAdmission(
  decision: ChannelIngressDecision,
  sideEffect: ChannelIngressSideEffectResult,
): ChannelTurnAdmission {
  if (decision.admission === "dispatch") {
    return { kind: "dispatch", reason: decision.reasonCode };
  }
  if (decision.admission === "observe") {
    return { kind: "observeOnly", reason: decision.reasonCode };
  }
  if (decision.admission === "pairing-required") {
    return sideEffect.kind === "pairing-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode };
  }
  if (decision.admission === "skip") {
    return sideEffect.kind === "pending-history-recorded" ||
      sideEffect.kind === "local-event-handled" ||
      sideEffect.kind === "command-reply-sent"
      ? { kind: "handled", reason: decision.reasonCode }
      : { kind: "drop", reason: decision.reasonCode, recordHistory: false };
  }
  return sideEffect.kind === "local-event-handled" || sideEffect.kind === "command-reply-sent"
    ? { kind: "handled", reason: decision.reasonCode }
    : { kind: "drop", reason: decision.reasonCode };
}
