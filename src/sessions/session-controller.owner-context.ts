import type { SessionAdmissionTransition } from "../config/sessions/session-admission-transition.types.js";
import { AsyncContext } from "../shared/async-context.js";
import { bindSessionControllerCleanupContext } from "./session-controller.cleanup-context.js";
import type { OwnerContext } from "./session-controller.contracts.js";
import { sessionTargetOwnersMatch, type SessionTarget } from "./session-controller.target.js";

// One context owner publishes its exit capability to the scheduler-facing leaf.
// Context carries exact controller objects; it grants no independent admission or authority.
export const ownerContext = new AsyncContext<OwnerContext>(
  Symbol.for("openclaw.sessionControllerOwnerContext"),
);
bindSessionControllerCleanupContext(ownerContext);

/** Only the effect that performs a committed initialization can advance its admitted input. */
export function bindSessionEffectTransition(
  target: SessionTarget,
  owner: object,
  adopt: (transition: SessionAdmissionTransition, isActive: () => boolean) => void,
): void {
  for (const effect of [...(ownerContext.getStore()?.effects ?? [])].toReversed()) {
    if (
      !effect.ref.isActive() ||
      !sessionTargetOwnersMatch(effect.ref.target, target) ||
      effect.ref.target.sessionKey !== target.sessionKey
    ) {
      continue;
    }
    (effect.admissionTransitions ??= new Map()).set(owner, adopt);
    return;
  }
}

export function acknowledgeSessionEffectTransition(
  target: SessionTarget,
  transition: SessionAdmissionTransition,
): void {
  for (const effect of ownerContext.getStore()?.effects ?? []) {
    if (
      effect.ref.isActive() &&
      sessionTargetOwnersMatch(effect.ref.target, target) &&
      effect.ref.target.sessionKey === target.sessionKey
    ) {
      for (const adopt of effect.admissionTransitions?.values() ?? []) {
        adopt(transition, () => effect.ref.isActive());
      }
    }
  }
}

/** Work that outlives the current turn (required cleanup, scheduled or fire-and-forget work)
 * leaves its controller context, so it acquires its own owner instead of inheriting the
 * retired turn. Nested work that belongs to the turn must not use this. */
export { runWithSessionControllerCleanup } from "./session-controller.cleanup-context.js";
