import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { settlesWithin } from "../shared/settle-within.js";
import { sourceSettlements } from "./session-controller.context.js";
import type { SessionEffectRef, SessionEffectInterrupt } from "./session-controller.contracts.js";
import {
  selectedClaims,
  selectedEffects,
  selectedOperations,
  allEffects,
} from "./session-controller.lifecycle-projections.js";
import { targetFrom, type TargetInput, type SessionTarget } from "./session-controller.target.js";

/** Awaits controller custody, rejecting with the caller's abort reason if it cancels first. */
export async function waitUnlessAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  return await racePromiseWithAbortSignal(pending, signal, (aborted) =>
    aborted.reason instanceof Error
      ? aborted.reason
      : new Error("Session operation cancelled", { cause: aborted.reason }),
  );
}

/** Start work only after all retiring source cleanup has settled. */
export async function runAfterRetiringSessionSources<T>(
  targets: readonly SessionTarget[],
  requiredSessionId: string | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  // Waiting inputs stay queued; only retiring inputs must settle before activation.
  for (;;) {
    const retiring = targets.flatMap((target) =>
      sourceSettlements(target, requiredSessionId, "retiring"),
    );
    if (!retiring.length) {
      // Invoke in this frame so a withdrawal cannot slip between the check and activation.
      return await run();
    }
    await waitUnlessAborted(Promise.all(retiring), signal);
  }
}

export async function waitForSessionControllerSettlement(
  released: Promise<void>,
  timeoutMs?: number,
): Promise<boolean> {
  if (timeoutMs === undefined) {
    await released;
    return true;
  }
  return await settlesWithin(released, Math.max(0, timeoutMs));
}
export function captureSessionControllerSettlement(params: TargetInput): Promise<void> | undefined {
  const target = targetFrom(params);
  const effects = [...selectedEffects([target])].filter((effect) => effect.phase !== "queued");
  const operations = [...selectedOperations([target])];
  const sources = sourceSettlements(target);
  if (!effects.length && !operations.length && !sources.length) {
    return undefined;
  }
  const settled = Promise.all([
    ...sources,
    ...effects.map((effect) => effect.ref.released),
    ...operations.map((operation) => operation.ownerSettlement),
  ]).then(() => undefined);
  // Captures may be discarded or joined later; preserve failures for callers
  // without turning an unused settlement receipt into an unhandled rejection.
  void settled.catch(() => {});
  return settled;
}
export function isSessionControllerWorkActive(
  scope: string,
  identities: Iterable<string | undefined>,
  agentId?: string,
): boolean {
  const target = targetFrom({ scope, identities, agentId });
  return (
    selectedClaims(target).length > 0 ||
    selectedOperations([target]).size > 0 ||
    [...selectedEffects([target])].some(
      (effect) => effect.phase === "acquired" || effect.phase === "writer",
    )
  );
}
/** Tokens are one-shot references stored on the exact effect owner, not admissions. */
export function consumeSessionEffectHandoff(
  params: TargetInput & {
    handoffId: string;
    onInterrupt?: SessionEffectInterrupt;
    isSettling?: () => boolean;
    getAbortReason?: () => unknown;
  },
): SessionEffectRef | undefined {
  const target = targetFrom(params);
  const token = params.handoffId.trim();
  for (const effect of selectedEffects([target])) {
    if (
      !effect.handoffs.has(token) ||
      !target.aliases.every((id) => effect.ref.target.aliases.includes(id))
    ) {
      continue;
    }
    effect.handoffs.delete(token);
    effect.interrupt = params.onInterrupt;
    effect.isSettling = params.isSettling ?? effect.isSettling;
    effect.getAbortReason = params.getAbortReason ?? effect.getAbortReason;
    if (effect.interrupted) {
      params.onInterrupt?.(effect.interrupted);
    }
    return effect.ref;
  }
  return undefined;
}

/** @internal Exposed for unit tests only. */
export function cancelSessionEffectHandoff(handoffId: string): boolean {
  for (const effect of allEffects()) {
    if (effect.handoffs.delete(handoffId.trim())) {
      effect.ref.release();
      return true;
    }
  }
  return false;
}
