import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  mergeRestartRecoveryTerminalRunIds,
  sameRestartRecoveryTerminalRunIds,
} from "./restart-recovery-state.js";
import type { TranscriptMessageAppendResult } from "./session-accessor.sqlite-contract.js";
import type { CodeModeWaitingClaimIntent } from "./session-accessor.types.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type CodeModeClaimAppend = {
  intent: CodeModeWaitingClaimIntent;
  result: TranscriptMessageAppendResult<unknown>;
};

/* oxlint-disable eslint/curly -- Keep bounded claim validation compact. */
export function buildCodeModeClaimPatch(
  currentEntry: SessionEntry,
  appends: readonly CodeModeClaimAppend[],
): Pick<SessionEntry, "codeModeWaitingClaims"> | undefined {
  if (!appends.length) return undefined;
  const now = Date.now();
  const claims = { ...currentEntry.codeModeWaitingClaims };
  for (const [runId, claim] of Object.entries(claims))
    if (claim.expiresAt <= now) delete claims[runId];
  for (const { intent, result } of appends) {
    const message = asOptionalRecord(result?.message);
    const details = asOptionalRecord(message?.details);
    const predecessor = claims[intent.runId];
    if (
      !result?.anchor ||
      message?.role !== "toolResult" ||
      message.toolCallId !== intent.sourceToolCallId ||
      message.toolName !== intent.sourceToolName ||
      currentEntry.lifecycleRevision !== intent.lifecycleRevision ||
      currentEntry.activeWriterRunId !== intent.writerRunId ||
      predecessor?.anchor.entryId !== intent.predecessorEntryId ||
      (intent.predecessorEntryId !== undefined &&
        predecessor?.sourceDigest !== intent.sourceDigest) ||
      (intent.outcome === "replace"
        ? details?.status !== "waiting" || details.runId !== intent.runId
        : details?.status !== "completed" && details?.status !== "failed")
    )
      throw new Error("Code Mode waiting claim changed before transcript commit");
    const { lifecycleRevision: _, outcome, runId, writerRunId: _writer, ...claim } = intent;
    if (outcome === "remove" || claim.expiresAt <= now) delete claims[intent.runId];
    else claims[runId] = { ...claim, anchor: result.anchor };
  }
  Object.entries(claims)
    .toSorted(([, left], [, right]) => right.expiresAt - left.expiresAt)
    .slice(64)
    .forEach(([runId]) => delete claims[runId]);
  return { codeModeWaitingClaims: Object.keys(claims).length ? claims : undefined };
}

export function sessionMatchesExpectedTranscriptTurn<T extends { entry: SessionEntry }>(
  selected: T | undefined,
  expected: {
    expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
    expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
  },
): selected is T {
  const expectedState = expected.expectedSessionState;
  return Boolean(
    selected &&
    selected.entry.sessionId === expected.expectedSessionId &&
    (expected.expectedLifecycleRevision === undefined ||
      selected.entry.lifecycleRevision === (expected.expectedLifecycleRevision ?? undefined)) &&
    (expected.expectedWriterRunId === undefined ||
      selected.entry.activeWriterRunId === expected.expectedWriterRunId) &&
    (expectedState === undefined ||
      (selected.entry.abortedLastRun === expectedState.abortedLastRun &&
        selected.entry.mainRestartRecovery?.cycleId === expectedState.mainRestartRecoveryCycleId &&
        selected.entry.mainRestartRecovery?.revision ===
          expectedState.mainRestartRecoveryRevision &&
        selected.entry.restartRecoveryBeforeAgentReplyState ===
          expectedState.restartRecoveryBeforeAgentReplyState &&
        selected.entry.restartRecoveryDeliveryReceiptState ===
          expectedState.restartRecoveryDeliveryReceiptState &&
        selected.entry.restartRecoveryDeliveryToolCallId ===
          expectedState.restartRecoveryDeliveryToolCallId &&
        selected.entry.restartRecoveryDeliveryRequestFingerprint ===
          expectedState.restartRecoveryDeliveryRequestFingerprint &&
        selected.entry.restartRecoveryDeliveryRunId ===
          expectedState.restartRecoveryDeliveryRunId &&
        selected.entry.restartRecoveryDeliverySourceRunId ===
          expectedState.restartRecoveryDeliverySourceRunId &&
        selected.entry.restartRecoveryRequesterAccountId ===
          expectedState.restartRecoveryRequesterAccountId &&
        selected.entry.restartRecoveryRequesterSenderId ===
          expectedState.restartRecoveryRequesterSenderId &&
        selected.entry.restartRecoverySameChannelThreadRequired ===
          expectedState.restartRecoverySameChannelThreadRequired &&
        selected.entry.restartRecoverySourceIngress ===
          expectedState.restartRecoverySourceIngress &&
        selected.entry.restartRecoverySourceReplyDeliveryMode ===
          expectedState.restartRecoverySourceReplyDeliveryMode &&
        sameRestartRecoveryTerminalRunIds(
          selected.entry.restartRecoveryTerminalRunIds,
          expectedState.restartRecoveryTerminalRunIds,
        ) &&
        selected.entry.status === expectedState.status)),
  );
}

export function buildExpectedTranscriptTurnSessionPatch(params: {
  appendedMessages: readonly { appended: boolean }[];
  currentEntry: SessionEntry;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionFile: string;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  touchSessionEntry?: boolean;
}): Partial<SessionEntry> {
  const appendedCount = params.appendedMessages.filter((message) => message.appended).length;
  const acceptedMessage =
    appendedCount > 0 ||
    (params.expectedSessionState !== undefined &&
      params.appendedMessages.some((message) => !message.appended));
  const touchUpdatedAt = params.touchSessionEntry === true && appendedCount > 0 ? Date.now() : 0;
  const restartRecoveryTerminalRunIds = params.sessionLifecyclePatch?.restartRecoveryTerminalRunIds
    ? mergeRestartRecoveryTerminalRunIds(
        params.currentEntry.restartRecoveryTerminalRunIds,
        params.sessionLifecyclePatch.restartRecoveryTerminalRunIds,
      )
    : undefined;
  return {
    ...(acceptedMessage ? params.sessionLifecyclePatch : undefined),
    ...(acceptedMessage && restartRecoveryTerminalRunIds ? { restartRecoveryTerminalRunIds } : {}),
    ...(touchUpdatedAt > 0
      ? {
          updatedAt: Math.max(
            params.currentEntry.updatedAt ?? 0,
            params.sessionLifecyclePatch?.updatedAt ?? 0,
            touchUpdatedAt,
          ),
        }
      : {}),
  };
}
