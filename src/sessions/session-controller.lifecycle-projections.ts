import { isAgentRunDirectAbortReason } from "../agents/run-termination.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { notifyListeners } from "../shared/listeners.js";
import type {
  ReplyOperation,
  Effect,
  Mutation,
  OwnerContext,
  SessionControllerLifecycle,
  SessionWorkRun,
  SessionControllerInput,
  SessionControllerMailboxClaim,
  SessionMutationKind,
} from "./session-controller.contracts.js";
import { getSessionControllerSourceIdentity } from "./session-controller.identity.js";
import {
  findSessionControllerEntries,
  sessionControllers,
  type SessionControllerEntry,
} from "./session-controller.state.js";
import * as controllerStorage from "./session-controller.storage.js";
import {
  sessionTargetOwnersMatch,
  targetFrom,
  type SessionTarget,
} from "./session-controller.target.js";

/** Source-backed effects share their input's identity rather than copying run metadata. */
export function getSessionEffectRun(effect: Effect): SessionWorkRun | undefined {
  const input = effect.sourceInput;
  return (
    effect.run ??
    (input?.protocolRunId !== undefined
      ? { runId: input.protocolRunId, ...getSessionControllerSourceIdentity(input) }
      : undefined)
  );
}

/** Resolve effect admission, including source preparation behind a settling predecessor. */
export function resolveSessionEffectAdmission(
  effect: Effect,
  state: SessionControllerLifecycle,
  current: OwnerContext | undefined,
  input?: SessionControllerInput,
): { allowed: boolean; finishingCapturedTurn: boolean } {
  const { entry } = effect;
  const operation = effect.ref.operation;
  const finishingCapturedTurn = Boolean(
    operation &&
    entry.active === operation &&
    state.mutations.some((mutation) => mutation.operations.has(operation)),
  );
  const borrowsMutation = state.mutations.some((mutation) => current?.mutations.has(mutation));
  // Source preparation owns no turn, but mutations and closures still fence it.
  const preparingSource = Boolean(
    input &&
    input.mailbox.owner === entry &&
    input.phase === "preparing" &&
    !input.retirementRequested &&
    !input.abortSignal.aborted &&
    !state.mutations.length &&
    !state.closures.size,
  );
  return {
    finishingCapturedTurn,
    allowed:
      !state.blocksTurnAdmission || borrowsMutation || finishingCapturedTurn || preparingSource,
  };
}

/** Incarnation is selected from the captured producer, never the mutable entry target. */
export function inputMatchesSessionId(input: SessionControllerInput, sessionId?: string): boolean {
  return (
    sessionId === undefined ||
    (input.source?.run.sessionId ?? input.target?.incarnation) === sessionId
  );
}

export function effectMatchesSessionId(effect: Effect, sessionId?: string): boolean {
  const target = effect.ref.target;
  return (
    sessionId === undefined ||
    target.incarnation === sessionId ||
    (!target.incarnation &&
      (effect.run?.sessionId === sessionId ||
        effect.ref.operation?.hasOwnedSessionId(sessionId) === true))
  );
}

export function claimMatchesSessionId(
  claim: SessionControllerMailboxClaim,
  sessionId?: string,
): boolean {
  return (
    sessionId === undefined ||
    (claim.operation
      ? claim.operation.hasOwnedSessionId(sessionId)
      : claim.inputs.some((input) => inputMatchesSessionId(input, sessionId)))
  );
}

function matches(a: SessionTarget, b: SessionTarget): boolean {
  return sessionTargetOwnersMatch(a, b) && a.aliases.some((id) => b.aliases.includes(id));
}
/** Wake maintenance only after acquired identity protection actually disappears. */
export function observeSessionControllerProtectionReleases(
  scope: string,
  listener: () => void,
): () => void {
  const key = scope.trim();
  const registry = controllerStorage.sessionControllerProtectionReleaseListeners;
  const listeners = registry.get(key) ?? new Set();
  listeners.add(listener);
  registry.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && registry.get(key) === listeners) {
      registry.delete(key);
    }
  };
}
export function notifySessionControllerProtectionReleased(target: SessionTarget): void {
  const listeners = controllerStorage.sessionControllerProtectionReleaseListeners.get(
    target.storeScope,
  );
  if (!listeners?.size) {
    return;
  }
  const protectedIdentities = collectSessionControllerTargets().get(target.storeScope);
  if (target.aliases.some((identity) => !protectedIdentities?.has(identity))) {
    notifyListeners(listeners, undefined);
  }
}
function isRestartRecoverableEffect(effect: Effect): boolean {
  const abortReason = effect.getAbortReason?.() ?? effect.interrupted;
  return (
    (effect.phase === "acquired" || effect.phase === "writer") &&
    (!effect.isSettling?.() || !isAgentRunDirectAbortReason(abortReason))
  );
}
function isRestartRecoverableOperation(operation: ReplyOperation): boolean {
  // Stop retains cleanup custody, not permission to resume the cancelled turn.
  return !isAgentRunDirectAbortReason(operation.abortSignal.reason);
}
function isRestartRecoverableClaim(claim: SessionControllerMailboxClaim): boolean {
  return (
    !isAgentRunDirectAbortReason(claim.abortController.signal.reason) &&
    (!claim.operation || isRestartRecoverableOperation(claim.operation))
  );
}
export function matchingEntries(target: SessionTarget): SessionControllerEntry[] {
  return findSessionControllerEntries(target.sessionKey, target);
}
export function selectedClaims(target: SessionTarget): SessionControllerMailboxClaim[] {
  return matchingEntries(target).flatMap((entry) =>
    entry.mailbox?.claim ? [entry.mailbox.claim] : [],
  );
}
export function selectedEffects(targets: readonly SessionTarget[]): Set<Effect> {
  return new Set(
    targets.flatMap((target) =>
      matchingEntries(target).flatMap((entry) =>
        [...(entry.lifecycle?.effects ?? [])].filter((effect) =>
          matches(effect.ref.target, target),
        ),
      ),
    ),
  );
}
export function selectedOperations(targets: readonly SessionTarget[]): Set<ReplyOperation> {
  const operations = new Set<ReplyOperation>();
  for (const target of targets) {
    for (const entry of matchingEntries(target)) {
      for (const operation of entry.lifecycle?.operations ?? []) {
        operations.add(operation);
      }
      if (entry.active) {
        operations.add(entry.active);
      }
    }
  }
  return operations;
}
export function* allEffects() {
  for (const entry of sessionControllers.values()) {
    yield* entry.lifecycle?.effects ?? [];
  }
}
function* allMutations(entries: Iterable<SessionControllerEntry> = sessionControllers.values()) {
  const seen = new Set<Mutation>();
  for (const entry of entries) {
    for (const mutation of entry.lifecycle?.mutations ?? []) {
      if (!seen.has(mutation)) {
        seen.add(mutation);
        yield mutation;
      }
    }
  }
}
export function collectSessionControllerTargets(
  owners?: ReadonlySet<object>,
  storeScope?: string,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const entries = storeScope
    ? (controllerStorage.sessionControllerEntriesByStore.get(storeScope) ?? [])
    : sessionControllers.values();
  for (const entry of entries) {
    const effects = [...(entry.lifecycle?.effects ?? [])].filter(
      (effect) =>
        (effect.phase === "acquired" || effect.phase === "writer") &&
        (!owners || owners.has(effect)),
    );
    const targets = [
      ...effects.map((effect) => effect.ref.target),
      ...(entry.mailbox?.claim && entry.target && (!owners || owners.has(entry.mailbox.claim))
        ? [entry.target]
        : []),
      ...((entry.active && (!owners || owners.has(entry.active))) ||
      [...(entry.lifecycle?.operations ?? [])].some((operation) => !owners || owners.has(operation))
        ? (entry.lifecycle?.targets.keys() ?? [])
        : []),
    ];
    for (const target of targets) {
      const identities = result.get(target.storeScope) ?? new Set();
      for (const id of target.aliases) {
        identities.add(id);
      }
      result.set(target.storeScope, identities);
    }
  }
  return result;
}
export function captureGatewaySessionControllerWork(resolveGatewayContext: GatewayContextResolver) {
  const owners = new Set<object>();
  for (const effect of allEffects()) {
    if (
      isRestartRecoverableEffect(effect) &&
      effect.generation === getAgentRunLifecycleGeneration() &&
      hasGatewayContextOwner(effect, resolveGatewayContext)
    ) {
      owners.add(effect);
    }
  }
  for (const entry of sessionControllers.values()) {
    const claim = entry.mailbox?.claim;
    if (
      claim &&
      isRestartRecoverableClaim(claim) &&
      hasGatewayContextOwner(claim, resolveGatewayContext)
    ) {
      owners.add(claim);
    }
    if (
      entry.active &&
      isRestartRecoverableOperation(entry.active) &&
      hasGatewayContextOwner(entry.active, resolveGatewayContext)
    ) {
      owners.add(entry.active);
    }
    for (const operation of entry.lifecycle?.operations ?? []) {
      if (
        isRestartRecoverableOperation(operation) &&
        hasGatewayContextOwner(operation, resolveGatewayContext)
      ) {
        owners.add(operation);
      }
    }
  }
  return {
    targets: collectSessionControllerTargets(owners),
    isActive: (params: {
      scope: string;
      sessionKey: string;
      sessionId: string;
      agentId?: string;
    }) => {
      const target = targetFrom({
        scope: params.scope,
        identities: [params.sessionKey, params.sessionId],
        agentId: params.agentId,
      });
      return (
        selectedClaims(target).some(
          (claim) => owners.has(claim) && isRestartRecoverableClaim(claim),
        ) ||
        [...selectedOperations([target])].some(
          (operation) =>
            owners.has(operation) &&
            isRestartRecoverableOperation(operation) &&
            operation.hasOwnedSessionId(params.sessionId),
        ) ||
        [...selectedEffects([target])].some(
          (effect) =>
            owners.has(effect) &&
            isRestartRecoverableEffect(effect) &&
            (effect.ref.target.aliases.length === 1 ||
              target.aliases.every((id) => effect.ref.target.aliases.includes(id))),
        )
      );
    },
  };
}
export function getSessionControllerWorkCount(): number {
  return [...sessionControllers.values()].filter(
    (entry) =>
      entry.active ||
      entry.mailbox?.claim ||
      entry.mailbox?.preparing ||
      // Idle dedupe-expiry timers do not own runnable work.
      (entry.mailbox?.dispatchEnabled && entry.mailbox.timer) ||
      entry.lifecycle?.operations.size ||
      [...(entry.lifecycle?.effects ?? [])].some(
        (effect) => effect.phase === "acquired" || effect.phase === "writer",
      ),
  ).length;
}
export function getSessionMutationCount(): number {
  return [...allMutations()].filter((mutation) => mutation.phase === "active").length;
}
export function isSessionMutationActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kinds?: readonly SessionMutationKind[],
): boolean {
  return matchingEntries(targetFrom({ scope, identities })).some((entry) =>
    entry.lifecycle?.mutations.some(
      (mutation) =>
        mutation.phase === "active" &&
        (!kinds || (mutation.kind !== undefined && kinds.includes(mutation.kind))),
    ),
  );
}
export function hasOnlySessionMutationKindActive(
  scope: string,
  identities: Iterable<string | undefined>,
  kind: "compaction" | "read-marker" | "background-result",
): boolean {
  const mutations = matchingEntries(targetFrom({ scope, identities })).flatMap(
    (entry) => entry.lifecycle?.mutations.filter((mutation) => mutation.phase === "active") ?? [],
  );
  return mutations.length > 0 && mutations.every((mutation) => mutation.kind === kind);
}
export function collectSessionMutationIdentities(scope: string): string[] {
  const normalizedScope = scope.trim();
  return [
    ...new Set(
      [
        ...allMutations(
          controllerStorage.sessionControllerEntriesByStore.get(normalizedScope) ?? [],
        ),
      ]
        .filter((mutation) => mutation.phase === "active")
        .flatMap((mutation) =>
          mutation.targets
            .filter((target) => target.storeScope === normalizedScope)
            .flatMap((target) => target.aliases),
        ),
    ),
  ].toSorted();
}

/** Capture scoped physical owners once; interruption never rediscovers a successor. */
export function selectSessionControllerInterruptionOwners(
  target: SessionTarget,
  current: OwnerContext | undefined,
  params: { requiredSessionId?: string; admissionsOnly?: boolean },
) {
  const effects = [...selectedEffects([target])].filter(
    (effect) =>
      effectMatchesSessionId(effect, params.requiredSessionId) &&
      !current?.effects.has(effect) &&
      (!current?.operation || effect.ref.operation !== current.operation),
  );
  const operations = [...selectedOperations([target])].filter(
    (operation) =>
      !params.admissionsOnly &&
      operation !== current?.operation &&
      (params.requiredSessionId === undefined ||
        operation.hasOwnedSessionId(params.requiredSessionId)),
  );
  const claims = selectedClaims(target).filter(
    (claim) =>
      (!params.admissionsOnly || !claim.operation) &&
      claimMatchesSessionId(claim, params.requiredSessionId) &&
      claim !== current?.claim &&
      (!current?.operation || claim.operation !== current.operation),
  );
  // Unclaimed preparation can still own a running plugin or native write.
  const sources = matchingEntries(target).flatMap((entry) =>
    (entry.mailbox?.entries ?? []).filter(
      (input) =>
        !input.claim &&
        input !== current?.sourceInput &&
        inputMatchesSessionId(input, params.requiredSessionId) &&
        Boolean(input.custody.work?.size),
    ),
  );
  return { effects, operations, claims, sources };
}
