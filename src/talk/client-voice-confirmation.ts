/** In-memory spoken confirmation binding for high-impact Talk actions. */
import { randomUUID } from "node:crypto";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import {
  requiresHighImpactVoiceConfirmation,
  stableToolFingerprint,
} from "./client-voice-confirmation-policy.js";

const CONFIRMATION_TTL_MS = 2 * 60_000;
const utteranceContextBrand = Symbol("voice-confirmation-utterance");

export type ClientVoiceConfirmationUtteranceContext = {
  readonly [utteranceContextBrand]: true;
};

type PendingVoiceConfirmation = {
  confirmationId: string;
  runId?: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  blockedCall?: { runId: string; toolCallId: string; toolName: string };
  changed: Deferred;
  utterance?: ClientVoiceConfirmationUtteranceContext;
  utteranceRejected?: true;
};

type RecentVoiceUserUtterance = {
  text: string;
  timestamp: number;
};

export type ClientVoiceConfirmationGrant = {
  agentId: string;
  voiceSessionId: string;
  confirmationId: string;
  fingerprint: string;
  expiresAt: number;
  retryContext?: string;
};

type ConfirmationScopeState = {
  pending?: PendingVoiceConfirmation;
  recentUtterance?: RecentVoiceUserUtterance;
  approvedByRun: Map<string, Map<string, number>>;
  observationsByRun: Map<string, Map<string, string>>;
  pendingExpiryTimer?: ReturnType<typeof setTimeout>;
};

const confirmationScopes = new Map<string, ConfirmationScopeState>();
const utteranceContexts = new WeakMap<
  ClientVoiceConfirmationUtteranceContext,
  {
    agentId: string;
    voiceSessionId: string;
    pending?: PendingVoiceConfirmation;
    timestamp: number;
    entryId?: string;
    persistedText?: string;
  }
>();

function confirmationScopeKey(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}

function clearPendingExpiryTimer(state: ConfirmationScopeState): void {
  if (!state.pendingExpiryTimer) {
    return;
  }
  clearTimeout(state.pendingExpiryTimer);
  delete state.pendingExpiryTimer;
}

function clearPendingConfirmation(state: ConfirmationScopeState): void {
  clearPendingExpiryTimer(state);
  state.pending?.changed.resolve();
  delete state.pending;
  delete state.recentUtterance;
}

function notifyPendingConfirmationChanged(pending: PendingVoiceConfirmation): void {
  const changed = pending.changed;
  pending.changed = createDeferredCore();
  changed.resolve();
}

function cleanupConfirmationScope(scopeKey: string, state: ConfirmationScopeState): void {
  if (
    state.pending ||
    state.recentUtterance ||
    state.approvedByRun.size > 0 ||
    state.observationsByRun.size > 0
  ) {
    return;
  }
  if (confirmationScopes.get(scopeKey) === state) {
    confirmationScopes.delete(scopeKey);
  }
}

function pruneExpiredPendingConfirmation(
  scopeKey: string,
  state: ConfirmationScopeState,
  now: number,
): void {
  if (state.pending && state.pending.expiresAt < now) {
    clearPendingConfirmation(state);
  }
  cleanupConfirmationScope(scopeKey, state);
}

function schedulePendingConfirmationExpiry(
  scopeKey: string,
  state: ConfirmationScopeState,
  now: number,
): void {
  const pending = state.pending;
  if (!pending) {
    clearPendingExpiryTimer(state);
    cleanupConfirmationScope(scopeKey, state);
    return;
  }
  clearPendingExpiryTimer(state);
  // The scope owns one current challenge and one timer. Supersession cancels
  // both together, while expiry remains inclusive at expiresAt.
  state.pendingExpiryTimer = setTimeout(
    () => {
      delete state.pendingExpiryTimer;
      if (confirmationScopes.get(scopeKey) !== state || state.pending !== pending) {
        return;
      }
      const current = Date.now();
      if (pending.expiresAt < current) {
        clearPendingConfirmation(state);
        cleanupConfirmationScope(scopeKey, state);
      } else {
        schedulePendingConfirmationExpiry(scopeKey, state, current);
      }
    },
    Math.max(1, pending.expiresAt - now + 1),
  );
  state.pendingExpiryTimer.unref?.();
}

function getPrunedConfirmationScope(
  scopeKey: string,
  now: number,
): ConfirmationScopeState | undefined {
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return undefined;
  }
  pruneExpiredPendingConfirmation(scopeKey, state, now);
  return confirmationScopes.get(scopeKey);
}

function getOrCreateConfirmationScope(scopeKey: string): ConfirmationScopeState {
  const existing = confirmationScopes.get(scopeKey);
  if (existing) {
    return existing;
  }
  const state: ConfirmationScopeState = {
    approvedByRun: new Map(),
    observationsByRun: new Map(),
  };
  confirmationScopes.set(scopeKey, state);
  return state;
}

function resolveApprovedFingerprint(
  scopeKey: string,
  runId: string | undefined,
  fingerprint: string,
  now: number,
  consume: boolean,
): boolean {
  if (!runId) {
    return false;
  }
  const state = confirmationScopes.get(scopeKey);
  const approved = state?.approvedByRun.get(runId);
  const expiresAt = approved?.get(fingerprint);
  if (!expiresAt || expiresAt < now) {
    approved?.delete(fingerprint);
    if (approved?.size === 0) {
      state?.approvedByRun.delete(runId);
    }
    if (state) {
      cleanupConfirmationScope(scopeKey, state);
    }
    return false;
  }
  if (consume) {
    approved?.delete(fingerprint);
    state?.observationsByRun.get(runId)?.delete(fingerprint);
    if (approved?.size === 0) {
      state?.approvedByRun.delete(runId);
    }
    if (state) {
      cleanupConfirmationScope(scopeKey, state);
    }
  }
  return true;
}

/** Capture host-observed speech before any finalization or persistence can change its challenge. */
export function captureClientVoiceConfirmationUtterance(params: {
  agentId: string;
  voiceSessionId: string;
  now?: number;
}): ClientVoiceConfirmationUtteranceContext {
  const timestamp = params.now ?? Date.now();
  const state = getPrunedConfirmationScope(
    confirmationScopeKey(params.agentId, params.voiceSessionId),
    timestamp,
  );
  const context: ClientVoiceConfirmationUtteranceContext = Object.freeze({
    [utteranceContextBrand]: true,
  });
  utteranceContexts.set(context, {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    pending: state?.pending,
    timestamp,
  });
  if (state?.pending) {
    delete state.recentUtterance;
    delete state.pending.utteranceRejected;
    state.pending.utterance = context;
    notifyPendingConfirmationChanged(state.pending);
  }
  return context;
}

/** Bind one transcript entry before queue admission; retries retain its original observation. */
export function prepareClientVoiceConfirmationTranscript(params: {
  agentId: string;
  voiceSessionId: string;
  entryId: string;
  confirmation?: ClientVoiceConfirmationUtteranceContext | null;
  now?: number;
}): ClientVoiceConfirmationUtteranceContext | null {
  if (params.confirmation === null) {
    return null;
  }
  const state = getPrunedConfirmationScope(
    confirmationScopeKey(params.agentId, params.voiceSessionId),
    params.now ?? Date.now(),
  );
  const current = state?.pending?.utterance;
  const context =
    params.confirmation ??
    (current && utteranceContexts.get(current)?.entryId === params.entryId
      ? current
      : captureClientVoiceConfirmationUtterance(params));
  const observed = utteranceContexts.get(context);
  if (
    !observed ||
    observed.agentId !== params.agentId ||
    observed.voiceSessionId !== params.voiceSessionId ||
    (observed.entryId !== undefined && observed.entryId !== params.entryId)
  ) {
    return null;
  }
  observed.entryId = params.entryId;
  return context;
}

/** A deduplicated write can reuse its original receipt, never manufacture a new one. */
export function recordClientVoiceConfirmationTranscriptAppend(params: {
  confirmation: ClientVoiceConfirmationUtteranceContext;
  entryId: string;
  text: string;
  appended: boolean;
}): void {
  const observed = utteranceContexts.get(params.confirmation);
  if (observed?.entryId === params.entryId && params.appended) {
    observed.persistedText = params.text;
  }
}

/** Record persisted speech only for the challenge and utterance observed before its write. */
export function noteClientVoiceConfirmationUtterance(params: {
  agentId: string;
  voiceSessionId: string;
  timestamp: number;
  confirmation: ClientVoiceConfirmationUtteranceContext;
}): void {
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const state = getPrunedConfirmationScope(scopeKey, params.timestamp);
  const observed = utteranceContexts.get(params.confirmation);
  if (
    !state?.pending ||
    !observed ||
    observed.agentId !== params.agentId ||
    observed.voiceSessionId !== params.voiceSessionId
  ) {
    return;
  }
  // Persisted refusal cancels its still-current challenge even when a later
  // utterance was observed while this write waited.
  if (
    observed.pending === state.pending &&
    observed.persistedText !== undefined &&
    REFUSAL_PATTERN.test(normalizeUtterance(observed.persistedText)) &&
    state.pending.createdAt < observed.timestamp
  ) {
    clearPendingConfirmation(state);
    cleanupConfirmationScope(scopeKey, state);
    return;
  }
  if (
    observed.pending !== state.pending ||
    state.pending.utterance !== params.confirmation ||
    observed.persistedText === undefined
  ) {
    if (!state.pending.utterance || state.pending.utterance === params.confirmation) {
      state.pending.utteranceRejected = true;
      notifyPendingConfirmationChanged(state.pending);
    }
    return;
  }
  state.recentUtterance = { text: observed.persistedText, timestamp: observed.timestamp };
  notifyPendingConfirmationChanged(state.pending);
}

type ClientVoiceToolConfirmationPolicyParams = {
  agentId?: string;
  voiceSessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  toolParams: unknown;
  isConfirmable?: () => boolean;
  now?: number;
};

type ClientVoiceToolConfirmationPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function resolveClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
  consume: boolean,
): ClientVoiceToolConfirmationPolicyResult {
  if (!params.agentId || !params.voiceSessionId) {
    return { allowed: true };
  }
  if (!requiresHighImpactVoiceConfirmation(params.toolName, params.toolParams)) {
    return { allowed: true };
  }
  // Sessions that cannot report spoken approvals (legacy clients without transcript
  // RPCs) keep pre-gate behavior; a pause they can never confirm is a dead end.
  // This is not a client trust boundary: authenticated clients can already run any
  // tool via chat.send. The gate guards against voice-channel misfires only.
  if (params.isConfirmable && !params.isConfirmable()) {
    return { allowed: true };
  }
  const now = params.now ?? Date.now();
  const fingerprint = stableToolFingerprint(params.toolName, params.toolParams);
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  if (resolveApprovedFingerprint(scopeKey, params.runId, fingerprint, now, consume)) {
    return { allowed: true };
  }
  const state = getPrunedConfirmationScope(scopeKey, now) ?? getOrCreateConfirmationScope(scopeKey);
  const pending = state.pending;
  const existing =
    pending && pending.runId === params.runId && pending.fingerprint === fingerprint
      ? pending
      : undefined;
  if (!existing) {
    clearPendingConfirmation(state);
  }
  const confirmation =
    existing ??
    ({
      confirmationId: randomUUID(),
      ...(params.runId ? { runId: params.runId } : {}),
      fingerprint,
      createdAt: now,
      expiresAt: now + CONFIRMATION_TTL_MS,
      changed: createDeferredCore(),
      ...(params.runId &&
      params.toolCallId &&
      params.runId.length <= 256 &&
      params.toolCallId.length <= 256 &&
      params.toolName.length <= 128
        ? {
            blockedCall: {
              runId: params.runId,
              toolCallId: params.toolCallId,
              toolName: params.toolName,
            },
          }
        : {}),
    } satisfies PendingVoiceConfirmation);
  state.pending = confirmation;
  const observation = params.runId ? state.observationsByRun.get(params.runId) : undefined;
  if (observation) {
    observation.set(fingerprint, confirmation.confirmationId);
  }
  schedulePendingConfirmationExpiry(scopeKey, state, now);
  return {
    allowed: false,
    reason:
      `VOICE_CONFIRMATION_REQUIRED:${confirmation.confirmationId} ` +
      `The high-impact voice action "${params.toolName}" was not executed. ` +
      (observation
        ? 'Ask the user to say "yes" to confirm this action or "no" to cancel it. A later native delegation carries the confirmation; do not add confirmationId to action tool arguments.'
        : "Ask the user for explicit spoken confirmation, then call openclaw_agent_consult again with this confirmationId."),
  };
}

/** Check whether one exact high-impact action is approved without consuming its grant. */
export function checkClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
): ClientVoiceToolConfirmationPolicyResult {
  return resolveClientVoiceToolConfirmationPolicy(params, false);
}

/** Authorize the canonical execution params and consume their one-shot grant. */
export function consumeClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
): ClientVoiceToolConfirmationPolicyResult {
  return resolveClientVoiceToolConfirmationPolicy(params, true);
}

/** Read transcript readiness without granting or extending the current challenge. */
export function readClientVoiceConfirmationReadiness(
  agentId: string,
  voiceSessionId: string,
):
  | {
      confirmationId: string;
      needsUserUtterance: boolean;
      utteranceRejected: boolean;
      changed: Promise<void>;
    }
  | undefined {
  const state = getPrunedConfirmationScope(
    confirmationScopeKey(agentId, voiceSessionId),
    Date.now(),
  );
  if (!state?.pending) {
    return undefined;
  }
  return {
    confirmationId: state.pending.confirmationId,
    needsUserUtterance: !hasLaterUserUtterance(state),
    utteranceRejected: state.pending.utteranceRejected === true,
    changed: state.pending.changed.promise,
  };
}

/** A newly observed user utterance cannot reuse an older final affirmation. */
export function invalidateClientVoiceConfirmationUtterance(
  agentId: string,
  voiceSessionId: string,
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  if (state) {
    delete state.recentUtterance;
    if (state.pending) {
      delete state.pending.utterance;
      notifyPendingConfirmationChanged(state.pending);
    }
    cleanupConfirmationScope(scopeKey, state);
  }
}

/** Retain this run's veto outcome for speech; this observation never authorizes an action. */
export function observeClientVoiceConfirmationRun(params: {
  agentId: string;
  voiceSessionId: string;
  runId: string;
}) {
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const state = getOrCreateConfirmationScope(scopeKey);
  const observation = new Map<string, string>();
  state.observationsByRun.set(params.runId, observation);
  return {
    readReply(): string | undefined {
      if (observation.size === 0) {
        return undefined;
      }
      const pending = confirmationScopes.get(scopeKey)?.pending;
      if (
        pending &&
        observation.get(pending.fingerprint) === pending.confirmationId &&
        pending.expiresAt >= Date.now()
      ) {
        return 'One pending action has not run. Say "yes" to confirm that action or "no" to cancel it.';
      }
      return "An action in that request was not run because its spoken confirmation is no longer current. Make a new request if you still want it.";
    },
    release(): void {
      const current = confirmationScopes.get(scopeKey);
      if (current?.observationsByRun.get(params.runId) === observation) {
        current.observationsByRun.delete(params.runId);
        cleanupConfirmationScope(scopeKey, current);
      }
    },
  };
}

const REFUSAL_PATTERN = /\b(no|don't|do not|cancel|stop|never mind)\b/;

function normalizeUtterance(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      // STT commonly emits typographic apostrophes; fold them so "don't" (U+2019)
      // matches the refusal pattern and cannot slip past as a non-refusal.
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[,;:.!?]+/g, "")
      .replace(/\s+/g, " ")
  );
}

function isExplicitAffirmation(text: string): boolean {
  const normalized = normalizeUtterance(text);
  if (REFUSAL_PATTERN.test(normalized)) {
    return false;
  }
  // English-only phrases are an accepted first version; localized matching is follow-up work.
  return /^(yes|yes do it|do it|confirm|confirmed|go ahead|proceed|send it|make the change|restart it)$/.test(
    normalized,
  );
}

function hasLaterUserUtterance(state: ConfirmationScopeState): boolean {
  return Boolean(
    state.pending &&
    state.recentUtterance &&
    state.recentUtterance.timestamp > state.pending.createdAt,
  );
}

function hasLaterExplicitAffirmation(state: ConfirmationScopeState): boolean {
  return Boolean(
    state.recentUtterance &&
    hasLaterUserUtterance(state) &&
    isExplicitAffirmation(state.recentUtterance.text),
  );
}

/** Native delegation has no tool arguments; only the call's persisted speech can confirm it. */
export function authorizeObservedClientVoiceConfirmation(params: {
  agentId: string;
  voiceSessionId: string;
  now?: number;
}): ClientVoiceConfirmationGrant | undefined {
  const now = params.now ?? Date.now();
  const state = getPrunedConfirmationScope(
    confirmationScopeKey(params.agentId, params.voiceSessionId),
    now,
  );
  if (!state?.pending || !hasLaterExplicitAffirmation(state)) {
    return undefined;
  }
  return authorizeClientVoiceConfirmation({
    ...params,
    now,
    confirmationId: state.pending.confirmationId,
  });
}

/** Bind a later affirmative utterance to one exact paused action. */
export function authorizeClientVoiceConfirmation(params: {
  agentId: string;
  voiceSessionId: string;
  confirmationId: string;
  now?: number;
}): ClientVoiceConfirmationGrant {
  const now = params.now ?? Date.now();
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const state = getPrunedConfirmationScope(scopeKey, now);
  const confirmation = state?.pending;
  if (!confirmation) {
    throw new Error("voice confirmation is missing, expired, or belongs to another action");
  }
  // A bare "yes" can only answer the question the model asked last; authorizing an
  // older challenge would let the model swap in a different pending action.
  if (confirmation.confirmationId !== params.confirmationId) {
    throw new Error("a newer confirmation request supersedes this one; ask again");
  }
  if (!hasLaterExplicitAffirmation(state)) {
    throw new Error("explicit spoken confirmation was not found after the action request");
  }
  // Validate only; the challenge and affirmation are consumed at bind time, once the
  // consult run is established. This keeps a failed/lost-response consult retryable
  // with the same confirmationId instead of leaving the action unconfirmable.
  return {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    confirmationId: params.confirmationId,
    fingerprint: confirmation.fingerprint,
    expiresAt: confirmation.expiresAt,
    ...(confirmation.blockedCall
      ? {
          retryContext:
            `The user's persisted spoken confirmation is bound to this previously blocked tool call: ${JSON.stringify(confirmation.blockedCall)}. ` +
            "Retry only that call with its unchanged arguments. Do not add confirmationId or other confirmation metadata to the action tool's arguments. This confirmation authorizes one exact action; other actions still require their own confirmation.",
        }
      : {}),
  };
}

/**
 * Bind a validated spoken grant to the one follow-up run and consume the
 * challenge. Invalidated detached grants return false without disrupting the
 * admitted run; final tool policy then blocks because no approval was created.
 */
export function bindAuthorizedClientVoiceConfirmation(params: {
  grant: ClientVoiceConfirmationGrant;
  runId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const scopeKey = confirmationScopeKey(params.grant.agentId, params.grant.voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  const pending = state?.pending;
  if (
    !state ||
    !pending ||
    pending.expiresAt < now ||
    pending.confirmationId !== params.grant.confirmationId ||
    pending.fingerprint !== params.grant.fingerprint ||
    pending.expiresAt !== params.grant.expiresAt ||
    !hasLaterExplicitAffirmation(state)
  ) {
    return false;
  }
  const approved = state.approvedByRun.get(params.runId) ?? new Map<string, number>();
  approved.set(pending.fingerprint, pending.expiresAt);
  state.approvedByRun.set(params.runId, approved);
  // Consume now that the run exists: one spoken affirmation authorizes one action.
  clearPendingConfirmation(state);
  cleanupConfirmationScope(scopeKey, state);
  return true;
}

/**
 * Remove ephemeral confirmation state when the logical call closes. Approved
 * grants for still-live consult runs survive: a spoken "yes" followed by hangup
 * must not re-block the confirmed action its run is about to execute.
 */
export function deactivateClientVoiceConfirmationSession(
  agentId: string,
  voiceSessionId: string,
  liveRunIds: readonly string[] = [],
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return;
  }
  clearPendingConfirmation(state);
  const live = new Set(liveRunIds);
  for (const runId of state.approvedByRun.keys()) {
    if (!live.has(runId)) {
      state.approvedByRun.delete(runId);
    }
  }
  for (const runId of state.observationsByRun.keys()) {
    if (!live.has(runId)) {
      state.observationsByRun.delete(runId);
    }
  }
  cleanupConfirmationScope(scopeKey, state);
}

/** Drop a completed run's surviving grants once its lifecycle ends. */
export function releaseClientVoiceConfirmationRun(
  agentId: string,
  voiceSessionId: string,
  runId: string,
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return;
  }
  state.approvedByRun.delete(runId);
  state.observationsByRun.delete(runId);
  cleanupConfirmationScope(scopeKey, state);
}

/** Test-only reset for process-global state. */
function resetClientVoiceConfirmationStateForTest(): void {
  for (const state of confirmationScopes.values()) {
    clearPendingExpiryTimer(state);
  }
  confirmationScopes.clear();
}

function snapshotClientVoiceConfirmationStateForTest() {
  const snapshot = {
    scopeOwners: confirmationScopes.size,
    pendingChallenges: 0,
    recentUtterances: 0,
    approvedRuns: 0,
    approvedGrants: 0,
    expiryOwners: 0,
  };
  for (const state of confirmationScopes.values()) {
    snapshot.pendingChallenges += state.pending ? 1 : 0;
    snapshot.recentUtterances += state.recentUtterance ? 1 : 0;
    snapshot.approvedRuns += state.approvedByRun.size;
    for (const approved of state.approvedByRun.values()) {
      snapshot.approvedGrants += approved.size;
    }
    snapshot.expiryOwners += state.pendingExpiryTimer ? 1 : 0;
  }
  return snapshot;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceConfirmationTestApi")
  ] = {
    resetClientVoiceConfirmationStateForTest,
    snapshotClientVoiceConfirmationStateForTest,
  };
}
