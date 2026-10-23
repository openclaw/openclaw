import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { captureGatewayScopeMatcher } from "../gateway/session-runtime-scope.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { sourceSettlements } from "./session-controller.context.js";
import type {
  ReplyOperation,
  Effect,
  SessionWorkRun,
  SessionControllerMailboxClaim,
  CapturedSessionControllerEffect,
  SessionControllerInput,
} from "./session-controller.contracts.js";
import { waitForSessionControllerSettlement } from "./session-controller.lifecycle-observation.js";
import {
  allEffects,
  effectMatchesSessionId,
  getSessionEffectRun,
  selectedEffects,
  selectSessionControllerInterruptionOwners,
} from "./session-controller.lifecycle-projections.js";
import { abortSessionControllerInput } from "./session-controller.mailbox-source.js";
import { ownerContext } from "./session-controller.owner-context.js";
import { targetFrom, type TargetInput } from "./session-controller.target.js";

export type { CapturedSessionControllerEffect } from "./session-controller.contracts.js";

/** Captures acquired producers without acquiring another work or cancellation owner. */
export function captureSessionControllerEffects(
  params: TargetInput & {
    requiredSessionId?: string;
    resolveGatewayContext?: GatewayContextResolver;
  },
): CapturedSessionControllerEffect[] {
  const current = ownerContext.getStore();
  const matchesGateway = Object.hasOwn(params, "resolveGatewayContext")
    ? captureGatewayScopeMatcher(params.resolveGatewayContext)
    : () => true;
  return [...selectedEffects([targetFrom(params)])].flatMap((effect) => {
    if (
      effect.phase !== "acquired" ||
      current?.effects.has(effect) ||
      !matchesGateway(effect) ||
      !effectMatchesSessionId(effect, params.requiredSessionId)
    ) {
      return [];
    }
    const run = getSessionEffectRun(effect);
    let interrupted = false;
    return [
      {
        effect,
        run,
        released: effect.ref.released,
        interrupt(reason: Error) {
          if (interrupted || effect.interrupted || !effect.ref.isActive()) {
            return undefined;
          }
          interrupted = true;
          const receipt = interruptSessionEffect(effect, reason);
          return {
            interrupted: true as const,
            ...(run && receipt?.runId === run.runId ? { run } : {}),
          };
        },
      },
    ];
  });
}

/** Observations project exact effect owners; they never acquire a scheduling slot. */
export function captureSessionWorkRunInterruptions(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  accept: (run: SessionWorkRun) => boolean;
}) {
  const current = ownerContext.getStore();
  return [...selectedEffects([targetFrom(params)])].flatMap((effect) => {
    const run = getSessionEffectRun(effect);
    if (!run || current?.effects.has(effect) || !params.accept(run)) {
      return [];
    }
    return [
      {
        run,
        released: effect.ref.released,
        interrupt: (reason: Error): boolean => {
          if (!effect.ref.isActive()) {
            return false;
          }
          // The captured producer is attempted once even if its receipt is rejected.
          effect.interrupted = reason;
          try {
            return effect.interrupt?.(reason)?.runId === run.runId;
          } finally {
            effect.cancel.abort(reason);
          }
        },
      },
    ];
  });
}

export function getCompetingSessionWorkAdmissionRelease(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  owner?: symbol;
  excludePendingOwner?: symbol;
  beforeClaim?: SessionControllerMailboxClaim;
}) {
  const current = ownerContext.getStore();
  const effects = [...selectedEffects([targetFrom(params)])].filter((effect) => {
    const input = effect.sourceInput;
    const claim = params.beforeClaim;
    // The selector already belongs to this claim. Unclaimed live sources on
    // that mailbox can only run afterward; their preparation is not prior work.
    if (
      claim &&
      input &&
      input.mailbox === claim.mailbox &&
      (claim.inputs.includes(input) ||
        (!input.claim && !input.retirementRequested && input.phase !== "consumed"))
    ) {
      return false;
    }
    return (
      !current?.effects.has(effect) &&
      (params.owner === undefined || effect.owner === params.owner) &&
      (!params.excludePendingOwner ||
        effect.owner !== params.excludePendingOwner ||
        effect.phase === "acquired")
    );
  });
  return effects.length
    ? Promise.all(effects.map((effect) => effect.ref.released)).then(() => undefined)
    : undefined;
}

export function getTerminalSessionWorkAdmissionRelease(params: {
  scope: string;
  identities: Iterable<string | undefined>;
  resolveGatewayContext?: GatewayContextResolver;
  preemptingOperations?: ReadonlySet<ReplyOperation>;
}): Promise<void> | false {
  const current = ownerContext.getStore();
  const matchesGateway = Object.hasOwn(params, "resolveGatewayContext")
    ? captureGatewayScopeMatcher(params.resolveGatewayContext)
    : () => true;
  const effects = [...selectedEffects([targetFrom(params)])].filter(
    (effect) =>
      effect.phase === "acquired" &&
      !current?.effects.has(effect) &&
      matchesGateway(effect) &&
      !(effect.ref.operation && params.preemptingOperations?.has(effect.ref.operation)),
  );
  if (effects.some((effect) => !effect.isSettling?.())) {
    return false;
  }
  return Promise.all(effects.map((effect) => effect.ref.released)).then(() => undefined);
}

/** Freeze shutdown owners before recovery persistence yields to new producers. */
export function captureGatewaySessionWorkAdmissionInterruption(
  resolveGatewayContext: GatewayContextResolver,
) {
  const effects = [...allEffects()].filter((effect) =>
    hasGatewayContextOwner(effect, resolveGatewayContext),
  );
  return {
    interrupt(reason: Error) {
      const cancellations = effects.map(async (effect) => {
        try {
          if (effect.phase !== "released" && !effect.interrupted && !effect.isSettling?.()) {
            interruptSessionEffect(effect, reason);
          }
        } finally {
          await effect.ref.released;
        }
      });
      return {
        inspectPending: () => {
          const pending = effects.filter((effect) => effect.phase !== "released");
          const first = pending[0];
          return {
            effects: pending.length,
            phase: first?.phase,
            sessionKey: first?.ref.target.sessionKey,
            runId: first ? getSessionEffectRun(first)?.runId : undefined,
            interrupted: first ? Boolean(first.interrupted) : undefined,
            sourcePhase: first?.sourceInput?.phase,
            operationPhase: first?.ref.operation?.phase,
            settling: first?.isSettling?.(),
          };
        },
        released: Promise.allSettled(cancellations).then((results) => {
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length) {
            throw new AggregateError(failures, "Gateway effect interruption failed");
          }
        }),
      };
    },
  };
}

export function interruptSessionEffect(effect: Effect, reason?: Error) {
  if (effect.interrupted) {
    return;
  }
  effect.interrupted ??= reason ?? new Error("Session effect interrupted");
  try {
    return effect.interrupt?.(effect.interrupted);
  } finally {
    effect.cancel.abort(effect.interrupted);
  }
}
/** Capture first, then interrupt: a replacement cannot inherit the cancellation. */
export function startSessionControllerInterruption(
  params: TargetInput & {
    reason?: Error;
    requiredSessionId?: string;
    admissionsOnly?: boolean;
    /** The caller already owns joining this exact raw source after its mutation releases. */
    deferSourceSettlement?: SessionControllerInput;
    assertCurrent?: () => void;
  },
): {
  released: Promise<void>;
  interruptedRunIds: ReadonlySet<string>;
} {
  const target = targetFrom(params);
  // Only an explicit restart reason may create restart-recovery custody.
  const reason = params.reason ?? new Error("Session effect interrupted");
  const { effects, operations, claims, sources } = selectSessionControllerInterruptionOwners(
    target,
    ownerContext.getStore(),
    params,
  );
  // Preserved queued inputs cannot settle behind the calling mutation. Only
  // retiring sources and captured interruption owners belong to this barrier.
  const settlements = [
    ...sourceSettlements(
      target,
      params.requiredSessionId,
      params.admissionsOnly ? "admissions" : "retiring",
    ),
    ...claims.map((claim) => claim.settlement.promise),
    ...effects.map((effect) => effect.ref.released),
    ...operations.map((operation) => operation.ownerSettlement),
    ...sources.map((input) => input.settlement.promise),
  ];
  const interruptedRunIds = new Set<string>();
  const failures: unknown[] = [];
  const interruptedSettlements: Promise<unknown>[] = [];
  let authorized = true;
  const canInterrupt = () => {
    if (!authorized) {
      return false;
    }
    try {
      params.assertCurrent?.();
      return true;
    } catch (error) {
      failures.push(error);
      authorized = false;
      return false;
    }
  };
  for (const claim of claims) {
    if (!canInterrupt()) {
      break;
    }
    interruptedSettlements.push(
      claim.settlement.promise,
      ...claim.inputs.map((input) => input.settlement.promise),
    );
    claim.abortController.abort(reason);
  }
  // Admission callbacks record their native cancellation receipt before raw source abort.
  for (const effect of effects) {
    if (!canInterrupt()) {
      break;
    }
    interruptedSettlements.push(effect.ref.released);
    try {
      const receipt = interruptSessionEffect(effect, reason);
      if (receipt) {
        interruptedRunIds.add(receipt.runId);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  for (const input of sources) {
    if (!canInterrupt()) {
      break;
    }
    interruptedSettlements.push(input.settlement.promise);
    try {
      abortSessionControllerInput(input, reason, params.assertCurrent);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const operation of operations) {
    if (!canInterrupt()) {
      break;
    }
    interruptedSettlements.push(operation.ownerSettlement);
    try {
      operation.abort(reason);
    } catch (error) {
      failures.push(error);
    }
  }
  return {
    interruptedRunIds,
    // If authority was revoked, join only effects actually authorized above.
    // Unaffected owners must not hold the caller's failure receipt open.
    released: Promise.all(
      (authorized ? settlements : interruptedSettlements).filter(
        (settlement) => settlement !== params.deferSourceSettlement?.settlement.promise,
      ),
    ).then(() => {
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Session interruption failed");
      }
    }),
  };
}

export async function interruptSessionControllerEffects(
  params: TargetInput & { reason?: Error; timeoutMs?: number },
): Promise<boolean> {
  return await waitForSessionControllerSettlement(
    startSessionControllerInterruption(params).released,
    params.timeoutMs,
  );
}
