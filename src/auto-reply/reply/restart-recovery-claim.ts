import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryBeforeAgentReplyState } from "../../config/sessions/restart-recovery-types.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-transcript-turn-lifecycle.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

type ReplyRestartRecoveryClaimController = {
  admitUserTurn: (recorder?: UserTurnTranscriptRecorder) => Promise<void>;
  checkpointBeforeAgentReply: (params: {
    state: Exclude<RestartRecoveryBeforeAgentReplyState, "pending">;
    pendingFinalDelivery?: {
      context?: DeliveryContext;
      intentId: string;
      text: string;
    };
  }) => Promise<void>;
  clear: () => Promise<void>;
  isArmed: () => boolean;
};

function buildExpectedSessionState(entry: SessionEntry): SessionTranscriptTurnExpectedState {
  return {
    abortedLastRun: entry.abortedLastRun,
    restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
    restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
    restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
    restartRecoveryDeliveryRequestFingerprint: entry.restartRecoveryDeliveryRequestFingerprint,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    restartRecoveryRequesterAccountId: entry.restartRecoveryRequesterAccountId,
    restartRecoveryRequesterSenderId: entry.restartRecoveryRequesterSenderId,
    restartRecoverySameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired,
    restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
    restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
}

function matchesExpectedSessionState(
  entry: SessionEntry,
  sessionId: string,
  expected: SessionTranscriptTurnExpectedState,
): boolean {
  return (
    entry.sessionId === sessionId &&
    entry.abortedLastRun === expected.abortedLastRun &&
    entry.restartRecoveryBeforeAgentReplyState === expected.restartRecoveryBeforeAgentReplyState &&
    entry.restartRecoveryDeliveryReceiptState === expected.restartRecoveryDeliveryReceiptState &&
    entry.restartRecoveryDeliveryToolCallId === expected.restartRecoveryDeliveryToolCallId &&
    entry.restartRecoveryDeliveryRequestFingerprint ===
      expected.restartRecoveryDeliveryRequestFingerprint &&
    entry.restartRecoveryDeliveryRunId === expected.restartRecoveryDeliveryRunId &&
    entry.restartRecoveryDeliverySourceRunId === expected.restartRecoveryDeliverySourceRunId &&
    entry.restartRecoveryRequesterAccountId === expected.restartRecoveryRequesterAccountId &&
    entry.restartRecoveryRequesterSenderId === expected.restartRecoveryRequesterSenderId &&
    entry.restartRecoverySameChannelThreadRequired ===
      expected.restartRecoverySameChannelThreadRequired &&
    entry.restartRecoverySourceIngress === expected.restartRecoverySourceIngress &&
    entry.restartRecoverySourceReplyDeliveryMode ===
      expected.restartRecoverySourceReplyDeliveryMode &&
    entry.status === expected.status &&
    entry.updatedAt === expected.updatedAt
  );
}

export function createReplyRestartRecoveryClaimController(params: {
  admissionRunId?: unknown;
  getEntry: () => SessionEntry | undefined;
  getSessionId: () => string;
  hasBeforeAgentReplyHook: boolean;
  isRestartAbort: () => boolean;
  resolveDeliveryContext: (entry: SessionEntry | undefined) => DeliveryContext | undefined;
  requesterAccountId?: unknown;
  requesterSenderId?: unknown;
  sessionKey?: string;
  setEntry: (entry: SessionEntry) => void;
  sameChannelThreadRequired?: boolean;
  sourceTurnId?: unknown;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  storePath?: string;
}): ReplyRestartRecoveryClaimController {
  let recoveryRunId: string = randomUUID();
  let recoverySourceRunId: string | undefined;
  let tracked = false;

  const persistAdmissionPatch = async (options: {
    entry: SessionEntry;
    patch: SessionTranscriptTurnLifecyclePatch;
    recorder?: UserTurnTranscriptRecorder;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<SessionEntry> => {
    const expectedSessionState = buildExpectedSessionState(options.entry);
    if (options.recorder && !options.recorder.hasPersisted()) {
      const result = await options.recorder.persistApproved({
        expectedSessionId: options.sessionId,
        expectedSessionState,
        sessionLifecyclePatch: options.patch,
      });
      if (!result?.sessionEntry) {
        throw new Error("session changed before durable user-turn admission");
      }
      return result.sessionEntry as SessionEntry;
    }
    const persisted = await updateSessionEntry(
      { storePath: options.storePath, sessionKey: options.sessionKey },
      (current) =>
        matchesExpectedSessionState(current, options.sessionId, expectedSessionState)
          ? options.patch
          : null,
    );
    if (!persisted) {
      throw new Error("restart recovery claim changed before agent adoption");
    }
    return persisted;
  };

  const persistUserTurnOnly = async (
    recorder: UserTurnTranscriptRecorder | undefined,
    sessionId: string,
  ): Promise<void> => {
    if (!recorder || recorder.hasPersisted()) {
      return;
    }
    const result = await recorder.persistApproved({ expectedSessionId: sessionId });
    if (!result) {
      throw new Error("session changed before durable user-turn admission");
    }
    if (result.sessionEntry) {
      params.setEntry(result.sessionEntry as SessionEntry);
    }
  };

  const admitUserTurn = async (recorder?: UserTurnTranscriptRecorder): Promise<void> => {
    if (!params.sessionKey || !params.storePath) {
      await recorder?.persistApproved();
      return;
    }
    const sessionId = params.getSessionId();
    const entry =
      params.getEntry() ??
      loadSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        clone: false,
        hydrateSkillPromptRefs: false,
      });
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error("session changed before durable user-turn admission");
    }
    const admissionRunId = normalizeOptionalString(params.admissionRunId);
    const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
    const activeClaimRunId = normalizeOptionalString(entry?.restartRecoveryDeliveryRunId);
    const isTranscriptOnlyClaim =
      admissionRunId &&
      entry &&
      entry.restartRecoveryDeliveryContext === undefined &&
      activeClaimRunId === admissionRunId;
    if (isTranscriptOnlyClaim) {
      if (entry.status !== "running" || entry.abortedLastRun === true) {
        throw new Error("restart recovery claim changed before agent adoption");
      }
      // Clear the retry verifier as the transcript-only claim crosses into execution.
      const adopted = await persistAdmissionPatch({
        entry,
        patch: {
          restartRecoveryBeforeAgentReplyState: params.hasBeforeAgentReplyHook
            ? "pending"
            : undefined,
          restartRecoveryDeliveryReceiptState: undefined,
          restartRecoveryDeliveryToolCallId: undefined,
          restartRecoveryDeliveryRequestFingerprint: undefined,
          updatedAt: Date.now(),
        },
        recorder,
        sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      params.setEntry(adopted);
      recoveryRunId = admissionRunId;
      recoverySourceRunId = normalizeOptionalString(adopted.restartRecoveryDeliverySourceRunId);
      tracked = true;
      return;
    }

    const deliveryContext = params.resolveDeliveryContext(entry);
    const recoverableDeliveryContext =
      deliveryContext && sourceTurnId ? deliveryContext : undefined;
    if (recoverableDeliveryContext) {
      const sourceMessage = recorder?.getPersistedMessage?.() ?? (await recorder?.resolveMessage());
      const persistedSourceTurnId = normalizeOptionalString(
        (sourceMessage as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
      );
      if (!recorder || persistedSourceTurnId !== sourceTurnId) {
        throw new Error("channel restart recovery requires source-keyed user-turn admission");
      }
    }
    if (!recoverableDeliveryContext && !activeClaimRunId) {
      // Source-less scheduled/ambient runs may execute, but cannot own a
      // channel recovery claim that would be impossible to correlate after restart.
      await persistUserTurnOnly(recorder, sessionId);
      return;
    }
    const updatedAt = Date.now();
    if (entry.abortedLastRun === true || (activeClaimRunId && entry.status === "running")) {
      throw new Error("restart recovery claim changed before agent adoption");
    }
    const retiredClaim = activeClaimRunId
      ? buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
          terminalSourceRunId: normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId),
        })
      : {};
    const patch: SessionTranscriptTurnLifecyclePatch = recoverableDeliveryContext
      ? {
          ...retiredClaim,
          abortedLastRun: false,
          endedAt: undefined,
          restartRecoveryBeforeAgentReplyState: params.hasBeforeAgentReplyHook
            ? "pending"
            : undefined,
          restartRecoveryDeliveryReceiptState: undefined,
          restartRecoveryDeliveryToolCallId: undefined,
          restartRecoveryDeliveryContext: recoverableDeliveryContext,
          restartRecoveryDeliveryRequestFingerprint: undefined,
          restartRecoveryDeliveryRunId: recoveryRunId,
          restartRecoveryDeliverySourceRunId: sourceTurnId,
          restartRecoveryRequesterAccountId: sourceTurnId
            ? normalizeOptionalString(params.requesterAccountId)
            : undefined,
          restartRecoveryRequesterSenderId: sourceTurnId
            ? normalizeOptionalString(params.requesterSenderId)
            : undefined,
          restartRecoverySameChannelThreadRequired:
            sourceTurnId && params.sameChannelThreadRequired === true ? true : undefined,
          restartRecoverySourceIngress: sourceTurnId ? "channel" : undefined,
          restartRecoverySourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          runtimeMs: undefined,
          startedAt: updatedAt,
          status: "running",
          updatedAt,
        }
      : { ...retiredClaim, updatedAt };
    const persisted = await persistAdmissionPatch({
      entry,
      patch,
      recorder,
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    params.setEntry(persisted);
    recoverySourceRunId = normalizeOptionalString(persisted.restartRecoveryDeliverySourceRunId);
    tracked = persisted.restartRecoveryDeliveryRunId === recoveryRunId;
  };

  const checkpointBeforeAgentReply: ReplyRestartRecoveryClaimController["checkpointBeforeAgentReply"] =
    async ({ state, pendingFinalDelivery }) => {
      if (!tracked || !params.sessionKey || !params.storePath) {
        return;
      }
      const updatedAt = Date.now();
      const persisted = await updateSessionEntry(
        { storePath: params.storePath, sessionKey: params.sessionKey },
        (current) =>
          current.sessionId === params.getSessionId() &&
          current.restartRecoveryDeliveryRunId === recoveryRunId &&
          current.restartRecoveryDeliverySourceRunId === recoverySourceRunId &&
          current.restartRecoveryBeforeAgentReplyState === "pending"
            ? {
                restartRecoveryBeforeAgentReplyState: state,
                ...(pendingFinalDelivery
                  ? {
                      pendingFinalDelivery: true,
                      pendingFinalDeliveryText: pendingFinalDelivery.text,
                      pendingFinalDeliveryIntentId: pendingFinalDelivery.intentId,
                      pendingFinalDeliveryContext: pendingFinalDelivery.context,
                      pendingFinalDeliveryCreatedAt: updatedAt,
                    }
                  : {}),
                updatedAt,
              }
            : null,
        { skipMaintenance: true, takeCacheOwnership: true },
      );
      if (!persisted) {
        throw new Error("before_agent_reply checkpoint lost restart recovery ownership");
      }
      params.setEntry(persisted);
    };

  const clear = async (): Promise<void> => {
    if (!tracked || !params.sessionKey || !params.storePath || params.isRestartAbort()) {
      return;
    }
    const persisted = await updateSessionEntry(
      { storePath: params.storePath, sessionKey: params.sessionKey },
      (current) =>
        current.sessionId === params.getSessionId() &&
        current.restartRecoveryDeliveryRunId === recoveryRunId
          ? {
              ...buildRestartRecoveryClaimCleanupPatch({
                entry: current,
                recordTerminalSource: true,
                terminalSourceRunId: recoverySourceRunId,
              }),
              updatedAt: Date.now(),
            }
          : null,
    );
    if (persisted) {
      params.setEntry(persisted);
    }
  };

  const isArmed = (): boolean => {
    if (!tracked || !params.sessionKey || !params.storePath) {
      return false;
    }
    const persisted = loadSessionEntry({
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      clone: false,
      hydrateSkillPromptRefs: false,
    });
    return persisted?.abortedLastRun === true || params.getEntry()?.abortedLastRun === true;
  };

  return { admitUserTurn, checkpointBeforeAgentReply, clear, isArmed };
}
