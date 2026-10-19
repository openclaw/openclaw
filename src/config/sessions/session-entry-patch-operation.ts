import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSubagentSessionRow } from "../../shared/session-list-visibility.js";
import type { SessionActivitySummary } from "./activity-summary.js";
import {
  projectAmbientTranscriptWatermark,
  type AmbientTranscriptWatermarkUpdate,
} from "./ambient-transcript-watermark-projection.js";
import {
  projectLastRoutePatch,
  projectSessionMetaPatch,
  type PreparedSessionMetaPatch,
} from "./metadata-projection.js";
import { resolveSessionObserverDigestForLifecycle } from "./observer-digest.js";
import { buildRestartRecoveryClaimCleanupPatch } from "./restart-recovery-state.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import type { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { preserveGenerationPrivateFields } from "./session-entry-public-patch.js";
import {
  projectSessionEntryUsageUpdate,
  type SessionEntryUsageUpdate,
} from "./session-entry-usage.js";
import {
  projectSessionLifecyclePatch,
  type SessionLifecyclePatchInput,
  type SessionLifecyclePatchEffects,
} from "./session-run-lifecycle-projection.js";
import { mergeSessionSnapshotChanges } from "./session-snapshot-merge.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type InternalSessionEntry as SessionEntry,
} from "./types.js";
import { createSessionWorkStartChangedError } from "./work-start-error.js";

type ExpectedSession = Pick<SessionEntry, "sessionId"> &
  Partial<Pick<SessionEntry, "lifecycleRevision" | "activeWriterRunId">>;

export type SessionEntryBookkeepingReducer =
  | { kind: "activity"; updatedAt: number }
  | { kind: "usage"; update: SessionEntryUsageUpdate; updatedAt: number }
  | { kind: "goal-continuation"; goalId: string }
  | { kind: "group-intro"; needsSystemIntro: boolean }
  | { kind: "fallback-notice"; notice: SessionEntry["fallbackNotice"] }
  | {
      kind: "live-model";
      expected: Partial<
        Pick<
          SessionEntry,
          | "modelProvider"
          | "model"
          | "agentHarnessId"
          | "providerOverride"
          | "modelOverride"
          | "agentRuntimeOverride"
          | "authProfileOverride"
          | "authProfileOverrideSource"
          | "liveModelSwitchPending"
        >
      >;
      next: Pick<SessionEntry, "modelProvider" | "model" | "agentHarnessId">;
      clearPending?: true;
    };

/** Closed internal operations; arbitrary updater callbacks retain prepare/CAS. */
type SessionEntryPatchStep = (
  | { kind: "fields"; patch: Partial<SessionEntry> }
  | { kind: "writer-revoke"; runId: string; terminalAtMs?: number }
  | {
      kind: "cron-session";
      sessionKey: string;
      initial?: SessionEntry;
      next: SessionEntry;
      creation: ReturnType<typeof buildSessionCreationStamp>;
    }
  | {
      kind: "cron-run-continuation";
      sessionKey: string;
      source: SessionEntry;
      continuation: NonNullable<SessionEntry["cronRunContinuation"]>;
      create: boolean;
      creation: ReturnType<typeof buildSessionCreationStamp>;
      thinkingLevel?: string;
    }
  | {
      kind: "inbound-metadata";
      metadata: PreparedSessionMetaPatch;
      sessionKey: string;
      creation: ReturnType<typeof buildSessionCreationStamp>;
    }
  | {
      kind: "last-route";
      route: Omit<Parameters<typeof projectLastRoutePatch>[0], "existing">;
      creation: ReturnType<typeof buildSessionCreationStamp>;
    }
  | { kind: "lifecycle"; lifecycle: SessionLifecyclePatchInput }
  | { kind: "public-fields"; patch: Partial<SessionEntry> }
  | {
      kind: "observer-digest";
      digest: NonNullable<SessionEntry["observerDigest"]>;
      sessionId?: string;
    }
  | { kind: "activity-summary"; summary: SessionActivitySummary; sessionKey: string }
  | { kind: "ambient-transcript-watermark"; watermark: AmbientTranscriptWatermarkUpdate }
  | {
      kind: "ensure-identity";
      sessionId: string;
      creation: ReturnType<typeof buildSessionCreationStamp>;
    }
  | {
      kind: "pending-final-clear";
      sessionId: string;
      intentId: string;
      recoveryRunId?: string;
      now: number;
    }
  | {
      kind: "restart-safe-terminal";
      runId: string;
      retryable: boolean;
      patch: Partial<SessionEntry>;
    }
  | {
      kind: "restart-claim-clear";
      sessionId: string;
      recoveryRunId: string;
      recoverySourceRunId?: string;
      executionRunId: string;
      executionGeneration: string;
      terminalRunId?: string;
    }
  | {
      kind: "compaction-accounting";
      accounting: Parameters<typeof projectCompactionAccountingPatch>[1];
    }
) & { expected?: ExpectedSession | null };

export type SessionEntryPatchOperation =
  | SessionEntryPatchStep
  | { kind: "compound"; operations: readonly SessionEntryPatchStep[] };

/** Shared by ordinary cron writes and the atomic reset-boundary owner. */
export function projectCronSessionEntry(
  operation: Extract<SessionEntryPatchOperation, { kind: "cron-session" }>,
  current: SessionEntry | undefined,
): SessionEntry {
  const { initial, next } = operation;
  // Serialized admission owns the revision; protect only row replacement or deletion here.
  if (
    current ? current.sessionId !== (initial?.sessionId ?? next.sessionId) : initial !== undefined
  ) {
    throw createSessionWorkStartChangedError(operation.sessionKey);
  }
  return current && initial
    ? mergeSessionSnapshotChanges({ initial, next, current })
    : { ...next, ...(!current ? operation.creation : {}) };
}

/** Each reducer observes its predecessor's postimage; callers persist only the result. */
export function projectSessionEntryPatch(
  params: Omit<Parameters<typeof mergeSessionEntryPatch>[0], "patch"> & {
    operation: SessionEntryPatchOperation;
    onLifecycleProjection?: (effects: SessionLifecyclePatchEffects | undefined) => void;
  },
): SessionEntry | undefined {
  const operations =
    params.operation.kind === "compound" ? params.operation.operations : [params.operation];
  let existing = params.existing;
  let writeBase = params.writeBase;
  let next: SessionEntry | undefined;
  for (const operation of operations) {
    const patch = reduceSessionEntryPatch(
      operation,
      writeBase,
      existing,
      params.onLifecycleProjection,
    );
    if (patch === null) {
      continue;
    }
    next = mergeSessionEntryPatch({ ...params, existing, writeBase, patch });
    if (next) {
      existing = writeBase = next;
    }
  }
  return next;
}

/** Shared by the actor and its retained native/SDK patch adapter. */
export function reduceSessionBookkeeping(
  entry: SessionEntry,
  reducer: SessionEntryBookkeepingReducer,
): Partial<SessionEntry> | null {
  switch (reducer.kind) {
    case "activity":
      return entry.updatedAt === 0
        ? null
        : { updatedAt: Math.max(entry.updatedAt, reducer.updatedAt) };
    case "usage":
      return projectSessionEntryUsageUpdate(entry, reducer.update, reducer.updatedAt);
    case "goal-continuation":
      // Completion may already have changed status; only the admitted Goal identity matters.
      return entry.goal?.id === reducer.goalId
        ? { goal: { ...entry.goal, continuationTurns: entry.goal.continuationTurns + 1 } }
        : null;
    case "group-intro":
      return { groupActivationNeedsSystemIntro: reducer.needsSystemIntro };
    case "fallback-notice":
      return { fallbackNotice: structuredClone(reducer.notice) };
    case "live-model":
      // SAFETY: This internal reducer's closed expected record contains only SessionEntry keys.
      for (const key of Object.keys(reducer.expected) as Array<keyof typeof reducer.expected>) {
        if (entry[key] !== reducer.expected[key]) {
          return null;
        }
      }
      return {
        ...reducer.next,
        ...(reducer.clearPending ? { liveModelSwitchPending: undefined } : {}),
      };
  }
  return reducer satisfies never;
}

export function reduceSessionEntryPatch(
  operation: SessionEntryPatchStep,
  entry: SessionEntry,
  existingEntry: SessionEntry | undefined,
  onLifecycleProjection?: (effects: SessionLifecyclePatchEffects | undefined) => void,
): Partial<SessionEntry> | null {
  const expected = operation.expected;
  const expectedEntry = operation.kind === "public-fields" ? existingEntry : entry;
  if (
    (expected === null && existingEntry !== undefined) ||
    (expected &&
      (!expectedEntry ||
        expectedEntry.sessionId !== expected.sessionId ||
        (Object.hasOwn(expected, "lifecycleRevision") &&
          expectedEntry.lifecycleRevision !== expected.lifecycleRevision) ||
        (Object.hasOwn(expected, "activeWriterRunId") &&
          expectedEntry.activeWriterRunId !== expected.activeWriterRunId)))
  ) {
    if (operation.kind === "public-fields") {
      throw new Error("Session entry changed before the conditional patch committed");
    }
    return null;
  }
  switch (operation.kind) {
    case "writer-revoke":
      return {
        activeWriterRunId: undefined,
        ...(operation.terminalAtMs !== undefined &&
        entry.status === undefined &&
        entry.lifecycleRunId === operation.runId
          ? {
              status: "killed",
              abortedLastRun: true,
              lifecycleRunId: undefined,
              endedAt: operation.terminalAtMs,
              updatedAt: operation.terminalAtMs,
            }
          : {}),
      };
    case "cron-session":
      return projectCronSessionEntry(operation, existingEntry);
    case "cron-run-continuation": {
      const { source, continuation, sessionKey } = operation;
      if (
        existingEntry
          ? existingEntry.cronRunContinuation?.lifecycleRevision !== continuation.lifecycleRevision
          : !operation.create
      ) {
        throw createSessionWorkStartChangedError(sessionKey);
      }
      // Ready transfers this row to detached continuation turns; the cron owner stops writing.
      if (existingEntry && existingEntry.cronRunContinuation?.phase !== "running") {
        if (
          continuation.phase === "ready" &&
          existingEntry.cronRunContinuation?.phase === "ready"
        ) {
          return null;
        }
        throw createSessionWorkStartChangedError(sessionKey);
      }
      return {
        ...existingEntry,
        ...(existingEntry
          ? preserveSqliteSameKeySessionRolloverLineage({
              next: source,
              previous: existingEntry,
              sessionKey,
            })
          : source),
        // Absence clears invalid native handles instead of resurrecting the prior binding.
        cliSessionBindings: source.cliSessionBindings,
        cliSessionIds: source.cliSessionIds,
        claudeCliSessionId: source.claudeCliSessionId,
        ...(!existingEntry ? operation.creation : {}),
        ...(operation.thinkingLevel ? { thinkingLevel: operation.thinkingLevel } : {}),
        cronRunContinuation: continuation,
      };
    }
    case "lifecycle": {
      const projection = projectSessionLifecyclePatch(entry, operation.lifecycle);
      onLifecycleProjection?.(projection.patch ? projection.effects : undefined);
      return projection.patch;
    }
    case "inbound-metadata": {
      const patch = projectSessionMetaPatch({
        prepared: operation.metadata,
        existing: existingEntry,
        sessionKey: operation.sessionKey,
      });
      return existingEntry ? patch : { ...operation.creation, ...patch };
    }
    case "last-route": {
      const patch = projectLastRoutePatch({ ...operation.route, existing: existingEntry });
      return existingEntry ? patch : { ...operation.creation, ...patch };
    }
    case "ensure-identity":
      return existingEntry?.sessionId
        ? null
        : existingEntry
          ? { sessionId: operation.sessionId }
          : { ...operation.creation, sessionId: operation.sessionId };
    case "fields":
      return operation.patch;
    case "public-fields":
      return preserveGenerationPrivateFields(entry, operation.patch);
    case "observer-digest": {
      const { digest, sessionId } = operation;
      const hasSessionIdentity = sessionId !== undefined || digest.sessionId !== undefined;
      if (
        (sessionId !== undefined && entry.sessionId !== sessionId) ||
        (digest.sessionId !== undefined && entry.sessionId !== digest.sessionId) ||
        ((hasSessionIdentity || digest.lifecycleRevision !== undefined) &&
          entry.lifecycleRevision !== digest.lifecycleRevision) ||
        (resolveSessionObserverDigestForLifecycle(entry.observerDigest, entry)?.revision ?? 0) >=
          digest.revision
      ) {
        return null;
      }
      return { observerDigest: digest };
    }
    case "activity-summary": {
      const { summary } = operation;
      return entry.initializationPending ||
        isSubagentSessionRow(operation.sessionKey, entry) ||
        entry.sessionId !== summary.sessionId ||
        entry.lifecycleRevision !== summary.lifecycleRevision
        ? null
        : { activitySummary: summary };
    }
    case "ambient-transcript-watermark":
      return projectAmbientTranscriptWatermark(entry, operation.watermark);
    case "compaction-accounting":
      return projectCompactionAccountingPatch(entry, operation.accounting);
    case "pending-final-clear": {
      const recoveryRunId = normalizeOptionalString(entry.restartRecoveryDeliveryRunId);
      const deliveries = entry.pendingFinalDelivery?.deliveries;
      if (
        entry.sessionId !== operation.sessionId ||
        entry.pendingFinalDelivery?.intentId !== operation.intentId ||
        !deliveries?.length ||
        !deliveries.every(({ state }) => state === "delivered" || state === "suppressed") ||
        (recoveryRunId !== undefined && recoveryRunId !== operation.recoveryRunId)
      ) {
        return null;
      }
      const completesHookTurn =
        recoveryRunId === undefined &&
        (entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
          entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable");
      return {
        ...(recoveryRunId
          ? buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: true })
          : {
              restartRecoveryBeforeAgentReplyState: undefined,
              restartRecoverySourceIngress: undefined,
              restartRecoveryOperatorSource: undefined,
              restartRecoveryForceSafeTools: undefined,
            }),
        pendingFinalDelivery: undefined,
        ...(completesHookTurn
          ? {
              abortedLastRun: false,
              endedAt: operation.now,
              lifecycleRunId: undefined,
              runtimeMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, operation.now - entry.startedAt)
                  : undefined,
              status: "done" as const,
            }
          : {}),
      };
    }
    case "restart-safe-terminal":
      return entry.restartRecoveryDeliveryRunId === operation.runId
        ? {
            ...operation.patch,
            ...(!operation.retryable
              ? buildRestartRecoveryClaimCleanupPatch({
                  entry,
                  recordTerminalSource: true,
                  terminalSourceRunId: entry.restartRecoveryDeliverySourceRunId,
                })
              : {}),
          }
        : null;
    case "restart-claim-clear": {
      const isExecutionFence = (run: NonNullable<SessionEntry["restartRecoveryRuns"]>[number]) =>
        run.runId === operation.executionRunId &&
        run.lifecycleGeneration === operation.executionGeneration;
      const ownsClaim =
        entry.restartRecoveryDeliveryRunId !== undefined
          ? entry.restartRecoveryDeliveryRunId === operation.recoveryRunId &&
            normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
              operation.recoverySourceRunId
          : entry.restartRecoveryRuns?.some(isExecutionFence) === true;
      if (
        entry.sessionId !== operation.sessionId ||
        (entry.abortedLastRun === true && entry.mainRestartRecovery !== undefined) ||
        !ownsClaim
      ) {
        return null;
      }
      // Unknown provider outcomes retire their source without replay. Until this
      // commit, the active receipt still belongs to restart-safe reconciliation.
      const terminalPending = entry.restartRecoveryDeliveryReceiptState === "terminal-pending";
      const preservesPendingFinal = !terminalPending && entry.pendingFinalDelivery !== undefined;
      const completesHandledSilent =
        entry.restartRecoveryBeforeAgentReplyState === "handled-silent" && !preservesPendingFinal;
      const endedAt = terminalPending || completesHandledSilent ? Date.now() : undefined;
      const remainingRuns = entry.restartRecoveryRuns?.filter((run) => !isExecutionFence(run));
      return {
        ...buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalSourceRunId: operation.recoverySourceRunId,
          terminalRunId:
            operation.terminalRunId ??
            (entry.restartRecoveryDeliveryRunId ? undefined : operation.executionRunId),
        }),
        restartRecoveryRuns: remainingRuns?.length ? remainingRuns : undefined,
        ...(terminalPending ? { pendingFinalDelivery: undefined } : {}),
        // Transport settlement owns the pending intent and its hook-safety provenance.
        ...(preservesPendingFinal
          ? {
              restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
              restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
              restartRecoveryForceSafeTools: entry.restartRecoveryForceSafeTools,
            }
          : {}),
        ...(endedAt !== undefined
          ? {
              abortedLastRun: terminalPending,
              endedAt,
              lifecycleRunId: undefined,
              runtimeMs:
                typeof entry.startedAt === "number"
                  ? Math.max(0, endedAt - entry.startedAt)
                  : undefined,
              status: terminalPending ? ("failed" as const) : ("done" as const),
            }
          : {}),
        updatedAt: endedAt ?? entry.updatedAt,
      };
    }
  }
  return operation satisfies never;
}

export function mergeSessionEntryPatch(params: {
  existing: SessionEntry | undefined;
  writeBase: SessionEntry;
  patch: Partial<SessionEntry> | null;
  sessionKey: string;
  replaceEntry?: boolean;
  preserveActivity?: boolean;
}): SessionEntry | undefined {
  const { existing, writeBase, patch, sessionKey } = params;
  // A fallback supplies identity, not an existing node's immutable creation policy.
  const creationPatch = !existing && patch ? { ...writeBase, ...patch } : patch;
  if (!creationPatch) {
    return undefined;
  }
  if (params.replaceEntry) {
    // SAFETY: The existing replaceEntry updater contract supplies a complete entry.
    return structuredClone(patch as SessionEntry);
  }
  const merged = params.preserveActivity
    ? mergeSessionEntryPreserveActivity(existing, creationPatch)
    : mergeSessionEntry(existing, creationPatch);
  return preserveSqliteSameKeySessionRolloverLineage({
    next: merged,
    previous: writeBase,
    sessionKey,
  });
}
