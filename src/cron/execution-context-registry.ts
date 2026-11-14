/**
 * Per-run lookup for the scheduled execution context. The admission owner binds
 * a context to its operational run instance; tool construction reads the
 * targets it needs. Leaf module: agent tools import it without cron's graph.
 */
import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import type { ScheduledMemoryParent } from "../plugins/memory-audience.js";
import type {
  ScheduledExecutionContextResult,
  ScheduledExecutionFacts,
} from "./execution-context.js";
import type { ScheduledExecutionContext } from "./scheduled-occurrence.js";

const contextsByRun = new WeakMap<OperationalRunInstanceRef, ScheduledExecutionContext>();

/** Admission-only: binds an occurrence's context to its admitted run. */
export function bindScheduledExecutionContext(
  run: OperationalRunInstanceRef,
  context: ScheduledExecutionContext,
): () => void {
  contextsByRun.set(run, context);
  return () => {
    if (contextsByRun.get(run) === context) {
      contextsByRun.delete(run);
    }
  };
}

/**
 * The session a scheduled run's board and widget tools act on, plus the
 * occurrence's assertion. Tools call `assertCurrent` before and inside each
 * effect so a reset or removed parent, or a settled run, refuses the write.
 */
export type ScheduledToolTargets = Readonly<{
  boardSessionKey: string;
  assertCurrent: () => void;
  /**
   * Set when a requester holds the run's owner authority. Owner-only tools call
   * it before each effect, so a requester who stops being an owner is refused.
   */
  assertOwnerCurrent?: () => void;
  /**
   * Where a scheduled occurrence runs relative to its requester. Undefined for
   * ingress turns, which keep their existing surface.
   */
  placement?: ScheduledExecutionFacts["placement"];
  /** The job's exec target pin, from the context's tool policy. */
  execTarget?: ScheduledExecutionFacts["toolPolicy"]["execTarget"];
}>;

/**
 * Targets for the run its owner names (an admitted run context or tool options),
 * or undefined when that run was not admitted with an execution context.
 */
export function readScheduledToolTargets(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): ScheduledToolTargets | undefined {
  const run = owner?.operationalRunInstance;
  const context = run ? contextsByRun.get(run) : undefined;
  if (!context) {
    return undefined;
  }
  // Admission sets the recheck only for a requester-held owner bit; in-session and
  // ingress runs keep their existing owner checks.
  const ownerRecheck = senderBitOf(context) ? context.assertOwnerCurrent : undefined;
  const { execTarget } = context.toolPolicy;
  return {
    boardSessionKey: context.resources.boardSessionKey,
    assertCurrent: context.assertCurrent,
    ...(ownerRecheck ? { assertOwnerCurrent: ownerRecheck } : {}),
    ...(context.principal.kind === "ingress" ? {} : { placement: context.placement }),
    ...(execTarget ? { execTarget } : {}),
  };
}

/**
 * Tool-construction options for a scheduled run on a Gateway-resolved surface:
 * its targets, plus the grant's tool cap as the run's allowance, matching the
 * embedded attempt. Empty when the run was not admitted with a context.
 */
export function readScheduledToolOptions(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
  toolsAllow: readonly string[] | undefined,
): { scheduledToolTargets?: ScheduledToolTargets; runtimeToolAllowlist?: string[] } {
  const scheduledToolTargets = readScheduledToolTargets(owner);
  if (!scheduledToolTargets) {
    return {};
  }
  return { scheduledToolTargets, ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow] } : {}) };
}

/**
 * The automations scope a scheduled occurrence (not an ingress turn) takes from
 * its admitted context, or undefined when the run has no such context.
 */
export function readScheduledOccurrenceAutomationsScope(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): ScheduledExecutionFacts["toolPolicy"]["automations"] | undefined {
  const run = owner?.operationalRunInstance;
  const context = run ? contextsByRun.get(run) : undefined;
  return context && context.principal.kind !== "ingress"
    ? context.toolPolicy.automations
    : undefined;
}

/**
 * The job a scope restricts the automations tool to, or undefined for no tool.
 * `self-and-parent-wake` offers the same self actions as `self`: waking the
 * parent is not offered until the parent-wake action lands (openclaw-0d5.9).
 */
export function readScheduledAutomationsSelfJobId(
  scope: ScheduledExecutionFacts["toolPolicy"]["automations"] | undefined,
): string | undefined {
  return scope && scope.scope !== "none" ? scope.jobId : undefined;
}

/**
 * The automations scope an ingress turn (hook or channel join introduction)
 * takes from its admitted context, or undefined when the run is not an ingress
 * turn admitted with a context.
 */
export function readScheduledIngressAutomationsScope(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): ScheduledExecutionFacts["toolPolicy"]["automations"] | undefined {
  const run = owner?.operationalRunInstance;
  const context = run ? contextsByRun.get(run) : undefined;
  return context?.principal.kind === "ingress" ? context.toolPolicy.automations : undefined;
}

/** The parent whose memory audience a child run inherits, or undefined to resolve from the run row. */
export function readScheduledMemoryParent(
  run: OperationalRunInstanceRef | undefined,
): ScheduledMemoryParent | undefined {
  const memory = run ? contextsByRun.get(run)?.resources.memory : undefined;
  if (memory?.source !== "parent") {
    return undefined;
  }
  const { parent, owner } = memory;
  return {
    sessionKey: parent.sessionKey,
    sessionId: parent.sessionId,
    ...(parent.lifecycleRevision ? { lifecycleRevision: parent.lifecycleRevision } : {}),
    senderIsOwner: owner,
  };
}

// In-session runs keep their session turn's own command-owner check, and ingress
// turns keep their existing surface; neither takes the bit from the context.
function senderBitOf(
  facts: Pick<ScheduledExecutionFacts, "authority" | "placement" | "principal">,
): Readonly<{ senderIsOwner?: false }> | undefined {
  if (facts.placement === "in-session" || facts.principal.kind === "ingress") {
    return undefined;
  }
  return facts.authority.owner ? {} : { senderIsOwner: false };
}

/**
 * The sender bit a scheduled run's tools take from its minted context, or
 * undefined when the context does not decide it.
 *
 * A scheduled run is an internal turn. An owner run carries no sender bit, which
 * keeps every owner-only tool except standing intents (they need an explicit
 * sender identity); a run whose requester is not an owner carries `false`.
 */
export function resolveScheduledSenderBit(
  result: ScheduledExecutionContextResult,
): Readonly<{ senderIsOwner?: false }> | undefined {
  return result.status === "ready" ? senderBitOf(result.facts) : undefined;
}

/** The sender bit for the run its owner names, when that run's context decides it. */
export function readScheduledSenderBit(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): Readonly<{ senderIsOwner?: false }> | undefined {
  const run = owner?.operationalRunInstance;
  const context = run ? contextsByRun.get(run) : undefined;
  return context ? senderBitOf(context) : undefined;
}
