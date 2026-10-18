import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import {
  agentWorkAdmissionIdentity,
  type AgentWorkAdmissionTarget,
} from "./session-agent-work-admission.js";
import type {
  ReplyOperation,
  Effect,
  Mutation,
  OwnerContext,
  SessionEffectInterrupt,
  SessionEffectRef,
  SessionWorkRun,
  SessionControllerInput,
} from "./session-controller.contracts.js";
import { createSessionControllerPhaseLogger } from "./session-controller.diagnostics.js";
import { assertAgentControllerAdmissionOpen } from "./session-controller.lifecycle-agent.js";
import {
  createLifecycleDiagnosticOperation,
  type SessionLifecycleDiagnosticLabel,
} from "./session-controller.lifecycle-diagnostics.js";
import {
  runAfterRetiringSessionSources,
  waitUnlessAborted,
} from "./session-controller.lifecycle-observation.js";
import {
  matchingEntries,
  claimMatchesSessionId,
  effectMatchesSessionId,
  selectedEffects,
  resolveSessionEffectAdmission,
  notifySessionControllerProtectionReleased,
} from "./session-controller.lifecycle-projections.js";
import {
  lifecycle,
  bindTarget,
  releaseTarget,
  notify,
  activate,
} from "./session-controller.lifecycle-state.js";
import { interruptSessionEffect } from "./session-controller.lifecycle-work.js";
import {
  prepareSessionMutationCompetition,
  runPreemptedSessionMutation,
  type SessionMutationPolicy,
} from "./session-controller.mutation-preemption.js";
import { ownerContext } from "./session-controller.owner-context.js";
import {
  assertSessionControllerOperation,
  getSessionControllerEntryForOperation,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import {
  targetFrom,
  type TargetInput,
  type IdentityTarget,
  type SessionTarget,
} from "./session-controller.target.js";

export {
  waitForSessionControllerSettlement,
  captureSessionControllerSettlement,
  isSessionControllerWorkActive,
  consumeSessionEffectHandoff,
  cancelSessionEffectHandoff,
} from "./session-controller.lifecycle-observation.js";
export {
  withSessionControllerOwner,
  getCurrentSessionControllerOwner,
  getCurrentSessionControllerClaim,
  withSessionControllerClaim,
  withSessionControllerSource,
  hasSessionControllerQueuedWork,
  isCompetingSessionControllerWorkActive,
} from "./session-controller.context.js";
export {
  bindSessionControllerTarget,
  retainSessionControllerOperation,
  releaseSessionControllerOperation,
} from "./session-controller.lifecycle-state.js";
export { captureSessionTarget, type SessionTarget } from "./session-controller.target.js";
export type { SessionEffectInterrupt, SessionEffectRef } from "./session-controller.contracts.js";
export {
  collectSessionControllerTargets,
  captureGatewaySessionControllerWork,
  getSessionControllerWorkCount,
  getSessionMutationCount,
  isSessionMutationActive,
  hasOnlySessionMutationKindActive,
  collectSessionMutationIdentities,
  observeSessionControllerProtectionReleases,
} from "./session-controller.lifecycle-projections.js";
export { SessionMutationPreemptTimeoutError } from "./session-controller.mutation-preemption.js";

export {
  closeAgentWorkAdmissions,
  collectActiveAgentSessionWorkAdmissions,
  startAgentWorkAdmissionInterruption,
} from "./session-controller.lifecycle-agent.js";
export {
  startSessionControllerInterruption,
  interruptSessionControllerEffects,
  captureSessionWorkRunInterruptions,
  getSessionWorkAdmissionOwnerRelease,
  getCompetingSessionWorkAdmissionRelease,
  getTerminalSessionWorkAdmissionRelease,
  captureGatewaySessionWorkAdmissionInterruption,
} from "./session-controller.lifecycle-work.js";
export { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "./session-controller.contracts.js";

/** Queues a mutation on canonical entries; ingress closes before awaited preemption or drain. */
export async function runSessionMutation<T>(
  params: {
    requiredSessionId?: string;
    diagnosticLabel?: SessionLifecycleDiagnosticLabel;
    prepare?: (owner: {
      closeWorkAdmissions: (reason: Error) => void;
      operations: readonly ReplyOperation[];
    }) => Promise<void>;
    finalize?: () => Promise<void>;
    run: () => Promise<T>;
    signal?: AbortSignal;
    assertCurrent?: () => void;
  } & SessionMutationPolicy &
    (TargetInput | { targets: Iterable<SessionTarget | IdentityTarget> }),
): Promise<T> {
  const current = ownerContext.getStore();
  const inheritedSignal = current?.claim?.abortController.signal ?? current?.operation?.abortSignal;
  const signal =
    params.signal && inheritedSignal
      ? AbortSignal.any([params.signal, inheritedSignal])
      : (params.signal ?? inheritedSignal);
  signal?.throwIfAborted();
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  assertCurrent();
  const run = () => {
    assertCurrent();
    return params.run();
  };
  const targets =
    "targets" in params
      ? [...params.targets].map((target) => ("storeScope" in target ? target : targetFrom(target)))
      : [targetFrom(params)];
  const bindings: Array<{ entry: SessionControllerEntry; target: SessionTarget }> = [];
  const releaseBindings = () => {
    for (const { entry, target } of bindings) {
      releaseTarget(entry, target);
    }
  };
  const entries = [
    ...new Set(
      targets.flatMap((target) => {
        const entry = bindTarget(target);
        bindings.push({ entry, target });
        return [entry, ...matchingEntries(target)];
      }),
    ),
  ].toSorted((a, b) => a.key.localeCompare(b.key));
  const matchesOperation = (operation: ReplyOperation) =>
    params.requiredSessionId === undefined || operation.hasOwnedSessionId(params.requiredSessionId);
  const borrowed = [...(current?.mutations ?? [])].find(
    (mutation) =>
      mutation.phase === "active" && entries.every((entry) => mutation.entries.includes(entry)),
  );
  const releases: Array<() => void> = [];
  const closeWorkAdmissions = (reason: Error) => {
    for (const target of targets) {
      assertCurrent();
      releases.push(closeSessionControllerAdmission({ target, reason }));
    }
  };
  if (borrowed) {
    try {
      await params.prepare?.({
        closeWorkAdmissions,
        operations: [...borrowed.operations].filter(matchesOperation),
      });
      return await run();
    } finally {
      try {
        await params.finalize?.();
      } finally {
        for (const release of releases) {
          release();
        }
        releaseBindings();
        for (const entry of entries) {
          notify(entry);
        }
      }
    }
  }
  const diagnostic = createLifecycleDiagnosticOperation({
    operation: params.kind === "compaction" ? "compaction" : "mutation",
    identities: () =>
      targets.flatMap((target) => target.aliases.map((alias) => `${target.storeScope}\0${alias}`)),
    signal,
    mutationKind: params.diagnosticLabel ?? params.kind,
  });
  const mutation: Mutation = {
    diagnostic,
    entries,
    targets,
    kind: params.kind,
    phase: "queued",
    operations: new Set(),
    ready: createDeferredCore(),
  };
  for (const entry of entries) {
    lifecycle(entry).mutations.push(mutation);
  }
  const dequeue = () => {
    const finishedAt = diagnostic ? performance.now() : undefined;
    diagnostic?.mark("release");
    mutation.phase = "released";
    releaseBindings();
    for (const entry of entries) {
      const queue = lifecycle(entry).mutations;
      const index = queue.indexOf(mutation);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      notify(entry);
    }
    diagnostic?.finish(finishedAt);
  };
  const withdraw = () => {
    if (mutation.phase !== "queued") {
      return;
    }
    dequeue();
    mutation.ready.reject(signal?.reason ?? new Error("Session mutation cancelled"));
  };
  signal?.addEventListener("abort", withdraw, { once: true });
  activate(mutation);
  if (signal?.aborted) {
    withdraw();
  }
  const stopMutationWait =
    mutation.phase === "queued"
      ? diagnostic?.wait(
          "mutation",
          () =>
            entries.find((entry) => entry.lifecycle?.mutations[0] !== mutation)?.lifecycle
              ?.mutations[0]?.diagnostic,
        )
      : undefined;
  try {
    await mutation.ready.promise;
  } finally {
    stopMutationWait?.();
    signal?.removeEventListener("abort", withdraw);
  }
  const context: OwnerContext = {
    sourceInput: current?.sourceInput,
    operation: current?.operation,
    claim: current?.claim,
    effects: current?.effects ?? new Set(),
    mutations: new Set([...(current?.mutations ?? []), mutation]),
  };
  return await ownerContext.run(context, async () => {
    let stopCompetitionWait: (() => void) | undefined;
    let pendingEffects: Set<Effect> | undefined;
    const runObserved = () => {
      stopCompetitionWait?.();
      diagnostic?.mark("run");
      return run();
    };
    try {
      signal?.throwIfAborted();
      assertCurrent();
      const competitors = [...mutation.operations].filter(
        (operation) => operation !== current?.operation && matchesOperation(operation),
      );
      const claims = entries.flatMap((entry) =>
        entry.mailbox?.claim &&
        claimMatchesSessionId(entry.mailbox.claim, params.requiredSessionId) &&
        entry.mailbox.claim !== current?.claim &&
        (!current?.operation || entry.mailbox.claim.operation !== current.operation)
          ? [entry.mailbox.claim]
          : [],
      );
      diagnostic?.mark("prepare");
      await params.prepare?.({ operations: competitors, closeWorkAdmissions });
      assertCurrent();
      diagnostic?.mark("run-admission");
      stopCompetitionWait = diagnostic?.wait(
        "lifecycle",
        () => pendingEffects?.values().next().value?.diagnostic,
      );
      const { waitForCompetitors, preemption } = await prepareSessionMutationCompetition({
        policy: params,
        claims,
        entries,
        competitors,
        requiredSessionId: params.requiredSessionId,
        targets,
        signal: params.signal,
        assertCurrent,
      });
      // Only started effects can write; pending validators stay owned through their real return.
      const effects = new Set(
        entries.flatMap((entry) =>
          [...(entry.lifecycle?.effects ?? [])].filter(
            (effect) =>
              effectMatchesSessionId(effect, params.requiredSessionId) &&
              (effect.phase === "validating" ||
                effect.phase === "writer" ||
                (waitForCompetitors && effect.phase === "acquired")) &&
              !current?.effects.has(effect),
          ),
        ),
      );
      const preservedSourceEffects = new Set(
        [...effects].filter(
          (effect) =>
            (params.policy === "wait" ||
              (params.policy === "preempt" && params.preempt.waitingInputs === "keep")) &&
            effect.sourceInput &&
            !effect.sourceInput.claim &&
            !effect.sourceInput.retirementRequested,
        ),
      );
      if (preemption) {
        const interrupted: Effect[] = [];
        try {
          for (const effect of effects) {
            if (!preservedSourceEffects.has(effect)) {
              assertCurrent();
              interrupted.push(effect);
              interruptSessionEffect(effect, preemption.reason);
            }
          }
        } catch (error) {
          // Revocation stops further effects, but already interrupted producers still own cleanup.
          await Promise.allSettled(interrupted.map((effect) => effect.ref.released));
          throw error;
        }
      }
      // Preserved source preparation must finish its writer barrier, but its
      // acquired admission lasts until the queued turn can run after this fence.
      pendingEffects = diagnostic ? new Set(effects) : undefined;
      const effectsSettled = Promise.all(
        [...effects].map((effect) => {
          const settled =
            waitForCompetitors && !preservedSourceEffects.has(effect)
              ? effect.ref.released
              : effect.validated.promise;
          return pendingEffects ? settled.then(() => pendingEffects?.delete(effect)) : settled;
        }),
      );
      if (preemption) {
        return await runPreemptedSessionMutation({
          preemption,
          effectsSettled,
          targets,
          requiredSessionId: params.requiredSessionId,
          signal: params.signal,
          run: runObserved,
        });
      }
      // Only the caller's signal cancels this wait; an inherited turn signal may be the target.
      await waitUnlessAborted(effectsSettled, params.signal);
      if (waitForCompetitors) {
        return await runAfterRetiringSessionSources(
          targets,
          params.requiredSessionId,
          runObserved,
          params.signal,
        );
      }
      return await runObserved();
    } finally {
      stopCompetitionWait?.();
      try {
        diagnostic?.mark("finalize");
        await params.finalize?.();
      } finally {
        for (const release of releases) {
          release();
        }
        dequeue();
      }
    }
  });
}

/** Subordinate physical-effect custody. This never reserves or serializes a turn. */
export async function beginSessionEffect(
  params: TargetInput & {
    agent?: AgentWorkAdmissionTarget;
    agentId?: string;
    statePath?: string;
    env?: NodeJS.ProcessEnv;
    run?: SessionWorkRun;
    owner?: symbol;
    /** Serialize preparation by the existing producer identity, not by a second turn queue. */
    serializeOwner?: boolean;
    isSettling?: () => boolean;
    getAbortReason?: () => unknown;
    storeWriterIdentities?: Iterable<string | undefined>;
    resolveGatewayContext?: GatewayContextResolver;
    operation?: ReplyOperation;
    sourceInput?: SessionControllerInput;
    assertAllowed?: (signal: AbortSignal) => Promise<void> | void;
    revalidateAllowed?: () => Promise<void> | void;
    onInterrupt?: SessionEffectInterrupt;
    signal?: AbortSignal;
  },
): Promise<SessionEffectRef> {
  if (isGatewaySubordinateWorkAdmissionClosed()) {
    throw new GatewayDrainingError();
  }
  const target = targetFrom(params);
  const entry = bindTarget(target);
  const state = lifecycle(entry);
  const current = ownerContext.getStore();
  const predecessors =
    params.serializeOwner && params.owner
      ? [...selectedEffects([target])].filter((effect) => effect.owner === params.owner)
      : [];
  if (
    predecessors.some(
      (effect) =>
        current?.effects.has(effect) &&
        target.aliases.every((identity) => effect.ref.target.aliases.includes(identity)),
    )
  ) {
    predecessors.length = 0;
  }
  const operation =
    params.operation ??
    (current?.operation && getSessionControllerEntryForOperation(current.operation) === entry
      ? current.operation
      : undefined);
  if (params.operation) {
    assertSessionControllerOperation(params.operation);
  }
  const resolver = Object.hasOwn(params, "resolveGatewayContext")
    ? params.resolveGatewayContext
    : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const cancel = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, cancel.signal]) : cancel.signal;
  const logAdmission = createSessionControllerPhaseLogger("lifecycle-admission", {
    sessionKey: target.sessionKey,
    sessionId: target.incarnation,
    sourceId: params.sourceInput?.protocolRunId ?? current?.claim?.inputs[0]?.protocolRunId,
  });
  const diagnostic = createLifecycleDiagnosticOperation({
    operation: "lifecycle",
    identities: () => target.aliases.map((alias) => `${target.storeScope}\0${alias}`),
    signal,
  });
  const settled = createDeferredCore();
  let running = 0;
  let releaseRequested = false;
  const ref: SessionEffectRef = {
    target,
    operation,
    isActive: () => effect.phase !== "released" && !releaseRequested && !effect.interrupted,
    released: settled.promise,
    release: () => {
      if (effect.phase === "released") {
        return;
      }
      releaseRequested = true;
      if (running > 0) {
        return;
      }
      const finishedAt = diagnostic ? performance.now() : undefined;
      diagnostic?.mark("release");
      const wasAcquired = effect.phase === "acquired";
      effect.phase = "released";
      effect.handoffs.clear();
      state.effects.delete(effect);
      releaseTarget(entry, target);
      effect.validated.resolve();
      settled.resolve();
      notify(entry);
      if (wasAcquired) {
        notifySessionControllerProtectionReleased(target);
      }
      diagnostic?.finish(finishedAt);
    },
    createHandoff: () => {
      if (effect.phase === "released") {
        throw new Error("Cannot hand off a released session effect");
      }
      const token = randomUUID();
      effect.handoffs.add(token);
      return token;
    },
    run: async <T>(run: () => Promise<T>): Promise<T> => {
      const caller = ownerContext.getStore();
      if (effect.phase === "released" || (releaseRequested && !caller?.effects.has(effect))) {
        throw new Error("Session effect custody has closed");
      }
      if (effect.interrupted) {
        throw effect.interrupted;
      }
      running++;
      try {
        return await ownerContext.run(
          {
            sourceInput: caller?.sourceInput ?? current?.sourceInput ?? effect.sourceInput,
            operation,
            claim: current?.claim ?? caller?.claim,
            effects: new Set([...(caller?.effects ?? []), effect]),
            mutations: caller?.mutations ?? new Set(),
          },
          () => withPluginRuntimeGatewayContextResolver(resolver, run),
        );
      } finally {
        running--;
        if (releaseRequested) {
          ref.release();
        }
      }
    },
  };
  const admissionAgentId = params.agentId ?? target.agentId;
  const admissionAgent =
    params.agent ??
    (admissionAgentId
      ? { agentId: admissionAgentId, statePath: params.statePath, env: params.env }
      : undefined);
  const effect: Effect = {
    diagnostic,
    sourceInput: params.sourceInput ?? current?.claim?.inputs[0],
    ref,
    entry,
    agent: admissionAgent ? agentWorkAdmissionIdentity(admissionAgent) : undefined,
    run: params.run,
    owner: params.owner,
    isSettling: params.isSettling,
    getAbortReason: params.getAbortReason ?? (() => signal.reason),
    phase: "queued",
    generation: getAgentRunLifecycleGeneration(),
    cancel,
    handoffs: new Set(),
    interrupt: params.onInterrupt,
    validated: createDeferredCore(),
  };
  bindGatewayContextResolver(effect, resolver);
  state.effects.add(effect);
  const admission = () => resolveSessionEffectAdmission(effect, state, current, params.sourceInput);
  logAdmission("waiting", "controller-admission");
  const stopAdmissionWait = diagnostic?.wait(
    "lifecycle",
    () =>
      predecessors.find((predecessor) => predecessor.phase !== "released")?.diagnostic ??
      state.mutations[0]?.diagnostic,
  );
  try {
    assertAgentControllerAdmissionOpen(effect);
    await waitUnlessAborted(
      Promise.all(predecessors.map((predecessor) => predecessor.ref.released)),
      signal,
    );
    signal.throwIfAborted();
    if (effect.agent) {
      const journal = await readAgentDeletionJournalStatusInWorker(
        effect.agent.agentId,
        { path: effect.agent.statePath, env: params.env },
        signal,
      );
      if (journal !== "absent") {
        throw new Error(
          "Agent " + effect.agent.agentId + " deletion is in progress; new work is unavailable.",
        );
      }
      assertAgentControllerAdmissionOpen(effect);
      signal.throwIfAborted();
    }
    const closure = state.closures.values().next().value;
    if (closure && !admission().finishingCapturedTurn) {
      interruptSessionEffect(effect, closure.reason);
      throw closure.reason;
    }
    // Source preparation owns no turn; the mailbox still fences execution behind the predecessor.
    while (!admission().allowed) {
      const pendingClosure = state.closures.values().next().value;
      if (pendingClosure) {
        interruptSessionEffect(effect, pendingClosure.reason);
        throw pendingClosure.reason;
      }
      await waitUnlessAborted(lifecycle(entry).changed.promise, signal);
      assertAgentControllerAdmissionOpen(effect);
    }
    signal.throwIfAborted();
    stopAdmissionWait?.();
    diagnostic?.hold();
    diagnostic?.mark("prepare");
    effect.phase = "validating";
    logAdmission("waiting", "validation");
    // Once validator I/O starts, custody is retained until it and the writer barrier settle.
    if (params.revalidateAllowed) {
      await waitUnlessAborted(
        ref.run(async () => await params.assertAllowed?.(signal)),
        signal,
      );
    }
    signal.throwIfAborted();
    if (isGatewaySubordinateWorkAdmissionClosed()) {
      throw new GatewayDrainingError();
    }
    effect.phase = "writer";
    logAdmission("waiting", "store-writer");
    let writerStarted = false;
    let removeAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => {
        if (!writerStarted) {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Session effect cancelled", { cause: signal.reason }),
          );
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        abort();
      }
    });
    const writer = runExclusiveSessionStoreWrite(
      target.storeScope,
      async () => {
        // A withdrawn queue callback has no writer capability or user work left.
        signal.throwIfAborted();
        writerStarted = true;
        assertAgentControllerAdmissionOpen(effect);
        await ref.run(async () => {
          if (params.revalidateAllowed) {
            await params.revalidateAllowed();
          } else {
            await params.assertAllowed?.(signal);
          }
        });
        signal.throwIfAborted();
      },
      { reentrant: true, identities: params.storeWriterIdentities, signal },
    );
    try {
      await Promise.race([writer, aborted]);
    } finally {
      removeAbort();
    }
    effect.phase = "acquired";
    diagnostic?.mark("run");
    logAdmission("settled", "acquired");
    effect.validated.resolve();
    return ref;
  } catch (error) {
    stopAdmissionWait?.();
    logAdmission("failed", signal.aborted ? "aborted" : effect.phase);
    ref.release();
    throw error;
  }
}

export function closeSessionControllerAdmission(
  params: TargetInput & { reason: Error; assertCurrent?: () => void },
): () => void {
  params.assertCurrent?.();
  const target = targetFrom(params);
  const entry = bindTarget(target);
  const closure = { reason: params.reason };
  lifecycle(entry).closures.add(closure);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    entry.lifecycle?.closures.delete(closure);
    releaseTarget(entry, target);
    notify(entry);
  };
  try {
    for (const effect of selectedEffects([target])) {
      if (effect.phase === "queued") {
        params.assertCurrent?.();
        interruptSessionEffect(effect, params.reason);
      }
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
