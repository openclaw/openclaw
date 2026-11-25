import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  isRequesterSettleWakeForRun,
  owesRequesterCompletion,
} from "../agents/subagents/registry/subagent-requester-settle-identity.js";
import {
  copySubagentRunRuntimeOwner,
  isSameSubagentRunOwner,
} from "../agents/subagents/registry/subagent-run-generation.js";
import { isYieldedSubagentRun } from "../agents/subagents/registry/subagent-run-liveness.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.js";
import { readSessionSubmittedInput } from "../config/sessions/session-pending-input-source.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionPendingInputRow } from "../config/sessions/session-pending-input.types.js";
import { isRestartResumeEntryOutOfScope } from "../config/sessions/session-restart-resume-scope.js";
import {
  acquireTranscriptLease,
  type TranscriptLease,
} from "../config/sessions/transcript-lease.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context-store.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { chatRef } from "../sessions/chat-ref.js";
import { UserProfileNotFoundError } from "../state/user-profiles-schema.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { WRITE_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import type {
  PreparedRestartStore,
  RestartResumeParams,
} from "./session-restart-resume-discovery.js";
import { prepareSessionSystemTurnAuthority } from "./session-sharing-authorization-async.js";

/** Fixed wording: no requester, grant, or result content reaches the chat. */
const RESTART_COMPLETION_REFUSED_NOTICE =
  "A background task's result couldn't be delivered because the access it ran under has ended.";
const REFUSED_NOTICE_SOURCE = "restart-completion-refused";
/** Results older than this settle without a chat notice. */
const REFUSED_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * The closed list of refusals that end a restored completion for good: the saved grant
 * or access record ended, or the saved profile is gone. Every other failure stays pending
 * and retries at the next restart, including refusals without such a cause (some compare
 * facts, such as the shared session generation, that the new process may rebuild).
 */
function isDefiniteRecoveryRefusal(error: unknown): boolean {
  if (!(error instanceof GatewayOperatorRecoveryAuthorizationError)) {
    return false;
  }
  const cause = error.cause;
  return (
    cause instanceof UserProfileNotFoundError ||
    (cause instanceof GatewayOperatorAccessDeniedError &&
      (cause.accessCause === "grant-revoked" || cause.accessCause === "access-record-inactive"))
  );
}

/** A consumed settle input transfers interrupted-turn recovery to the Gateway. */
export async function hasInterruptedCommittedRequesterSettleInput(
  scope: PendingInputScope,
  entry: Pick<InternalSessionEntry, "lifecycleRunId" | "lastRunId" | "status" | "endedAt">,
): Promise<boolean> {
  // An ended execution without a terminal status retains its deliberately yielded wait.
  if (entry.status === undefined && Number.isFinite(entry.endedAt)) {
    return false;
  }
  const runId = entry.lifecycleRunId ?? entry.lastRunId;
  if (!runId?.startsWith("announce:requester-settle:")) {
    return false;
  }
  const input = await readSessionSubmittedInput(scope, `${runId}:user`, { includeSource: true });
  return (
    input?.source === "transcript" && input.message.provenance?.sourceTool === "subagent_settle"
  );
}

/** Admit retained obligations before classifying nested waits in this store. */
export async function prepareRestartCompletionCustody(
  { context, signal, log }: RestartResumeParams,
  { target, entries }: Pick<PreparedRestartStore, "target" | "entries">,
): Promise<{
  assertCurrent: () => void;
  ownsInput: (row: SessionPendingInputRow, agentId: string) => boolean;
  resume: () => void;
}> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  assertCurrent();
  const recovered: SubagentRunRecord[] = [];
  let settledWithoutNotice = 0;
  for (const { sessionKey, entry } of entries) {
    // A completion wakes parent work; work from another restart resume scope never regains it.
    if (isRestartResumeEntryOutOfScope(entry)) {
      continue;
    }
    try {
      const outcome = await recoverRequesterCompletionCustody({
        context,
        ...target,
        sessionKey,
        entry,
        agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
        assertCurrent,
        log,
      });
      recovered.push(...outcome.recovered);
      settledWithoutNotice += outcome.settledWithoutNotice;
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
    }
  }
  if (settledWithoutNotice > 0) {
    log.warn(
      `Restart completion recovery settled ${settledWithoutNotice} refused results older than 7 days without a chat notice; their results remain in the subagent run records.`,
    );
  }
  return {
    assertCurrent,
    ownsInput: (row, agentId) => {
      assertCurrent();
      const message = parseSessionPendingInputMessage(row.message_json);
      if (
        message.provenance?.kind !== "inter_session" ||
        message.provenance.sourceTool !== "subagent_settle" ||
        row.idempotency_key !== `${row.run_id}:user`
      ) {
        return false;
      }
      const runs = [...getSubagentRunsForRequesterSession(row.session_key)];
      const runsById = new Map(runs.map((entry) => [entry.runId, entry]));
      // The queue reader already excludes replaced transcripts. Only a freshly
      // recovered cohort retains its input; orphaned or refused sources still fail.
      return runs.some(
        (entry) =>
          recovered.some((owner) => isSameSubagentRunOwner(entry, owner)) &&
          !subagentRuns.isCompletionAuthorityRetired(entry) &&
          entry.requesterSettleWake?.batchRunIds?.some(
            (runId) =>
              runsById.get(runId)?.childSessionKey === message.provenance?.sourceSessionKey,
          ) === true &&
          isRequesterSettleWakeForRun({
            entry,
            runId: row.run_id,
            requesterSessionKey: row.session_key,
            requesterAgentId: agentId,
            runsById,
          }),
      );
    },
    resume: () => {
      signal.throwIfAborted();
      if (!isGatewayRestartDraining()) {
        for (const owner of recovered) {
          if (isSameSubagentRunOwner(subagentRuns.get(owner.runId), owner)) {
            resumeSubagentRun(owner.runId);
          }
        }
      }
    },
  };
}

/** Recover the obligation under a fresh exact requester admission, never its stored bearer. */
async function recoverRequesterCompletionCustody(params: {
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt">;
  assertCurrent: () => void;
  log: RestartResumeParams["log"];
}): Promise<{ recovered: SubagentRunRecord[]; settledWithoutNotice: number }> {
  const { context, entry, agentId, sessionKey, storePath, assertCurrent, log } = params;
  if (entry.archivedAt !== undefined) {
    return { recovered: [], settledWithoutNotice: 0 };
  }
  const pending = [...getSubagentRunsForRequesterSession(sessionKey)].filter(
    (child) =>
      child.requesterAgentId === agentId &&
      subagentRuns.isCompletionAuthorityRetired(child) &&
      ((isYieldedSubagentRun(child) && owesRequesterCompletion(child)) ||
        child.requesterSettleWake !== undefined ||
        child.delivery?.status === "pending" ||
        child.delivery?.status === "in_progress" ||
        child.delivery?.status === "failed"),
  );
  if (!pending.length) {
    return { recovered: [], settledWithoutNotice: 0 };
  }
  const recovered: SubagentRunRecord[] = [];
  const refused: SubagentRunRecord[] = [];
  let target: TranscriptLease | undefined;
  try {
    target = await acquireTranscriptLease(
      chatRef({ agentId, sessionKey, storePath }),
      { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
      { env: params.env },
    );
    const requester = target;
    for (const child of pending) {
      let authority: { authority: AdmittedRunOperatorAuthority; release: () => void } | undefined;
      try {
        // Re-admit the spawning requester's saved source; the woken turn checks session access
        // when it starts. Older rows use the session principal, else the System write baseline.
        const source = child.requesterOperatorSource;
        if (child.requiresCompletionAuthority && !source) {
          throw new Error("Participant completion requires its original requester source.");
        }
        authority = source
          ? await restoreGatewayQueuedOperatorRecovery({ agentId, source, context, assertCurrent })
          : await prepareSessionSystemTurnAuthority({
              context,
              agentId,
              sessionKey,
              storePath,
              sessionId: entry.sessionId,
              preserveRecordedSource: true,
              assertCurrent,
            });
        await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
          withOperatorToolGatewayAuthority(
            {
              operatorRunAuthority: authority?.authority,
              operatorRoleActor: { kind: "system" },
              scopes: authority?.authority.scopes ?? [WRITE_SCOPE],
              assertCurrent,
            },
            async () => {
              const custody = await captureOperatorToolGatewayContinuationContext({
                agentId,
                sessionKey,
              });
              if (!custody) {
                throw new Error("Restart completion has no current Gateway authority");
              }
              try {
                assertCurrent();
                requester.assertCurrent();
                bindGatewayContextResolver(child, context.resolveGatewayContext);
                subagentRuns.bindCompletionAuthority(child, custody);
              } catch (error) {
                custody.release();
                throw error;
              }
            },
          ),
        );
        recovered.push(copySubagentRunRuntimeOwner(child, { ...child }));
      } catch (error) {
        // Shutdown or a changed requester chat stops every child; one refused source stops one.
        assertCurrent();
        requester.assertCurrent();
        log.warn(
          `Restart completion recovery failed for ${child.runId} in ${sessionKey}: ${String(error)}`,
        );
        if (isDefiniteRecoveryRefusal(error)) {
          refused.push(child);
        }
      } finally {
        authority?.release();
      }
    }
  } finally {
    target?.release();
  }
  let settledWithoutNotice = 0;
  if (refused.length) {
    try {
      settledWithoutNotice = await settleRefusedRestartCompletions({
        chat: { agentId, sessionKey, storePath, sessionId: entry.sessionId },
        refused,
        assertCurrent,
      });
    } catch (error) {
      // Recovered siblings keep their custody; the refused rows stay pending for the next restart.
      assertCurrent();
      log.warn(`Restart completion refusal settlement failed in ${sessionKey}: ${String(error)}`);
    }
  }
  return { recovered, settledWithoutNotice };
}

/**
 * The newest time the row records for its result or its delivery. This errs toward
 * notifying: creation time decides only when nothing later was recorded.
 */
function latestRecordedTime(child: SubagentRunRecord): number {
  const times = [
    child.completion?.capturedAt,
    child.completion?.fallbackCapturedAt,
    child.execution.endedAt,
    child.delivery?.payload?.endedAt,
    child.delivery?.createdAt,
    child.delivery?.enqueuedAt,
    child.delivery?.lastAttemptAt,
    child.delivery?.suspendedAt,
  ].filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  return times.length ? Math.max(...times) : child.createdAt;
}

/**
 * Ends refused obligations once, keeping each result in its run record. The original
 * requesting chat gets one fixed notice for its recent results, written before the rows
 * settle so a failed notice leaves them pending. Returns how many settled silently.
 */
async function settleRefusedRestartCompletions(params: {
  chat: { agentId: string; sessionKey: string; storePath: string; sessionId: string };
  refused: readonly SubagentRunRecord[];
  assertCurrent: () => void;
}): Promise<number> {
  const { chat, refused, assertCurrent } = params;
  const now = Date.now();
  const recent = refused.filter(
    (child) => now - latestRecordedTime(child) <= REFUSED_NOTICE_MAX_AGE_MS,
  );
  if (recent.length) {
    // Only a digest of the settled results enters the chat row; it dedupes a repeated notice.
    const resultsKey = sha256Hex(
      recent
        .map((child) => child.runId)
        .toSorted()
        .join("\n"),
    );
    const result = await runWithoutOwnedSessionTranscriptWrites(() =>
      appendSessionTranscriptReport(chat, {
        kind: "custom",
        customTypes: ["openclaw.system-note"],
        // A repeat after a failed settle write names the same results; do not post it twice.
        selectReport: (latest) => {
          return isRecord(latest?.details) &&
            latest.details.source === REFUSED_NOTICE_SOURCE &&
            latest.details.resultsKey === resultsKey
            ? undefined
            : {
                customType: "openclaw.system-note",
                content: RESTART_COMPLETION_REFUSED_NOTICE,
                display: true,
                details: { source: REFUSED_NOTICE_SOURCE, resultsKey },
              };
        },
      }),
    );
    if (!result.ok) {
      throw new Error(
        `Restart completion refusal notice could not be appended: ${result.error.code}`,
      );
    }
  }
  await mutateSubagentRuns(
    refused.map((child) => child.runId),
    (rows) => {
      const postimages = new Map<string, SubagentRunRecord>();
      for (const child of refused) {
        const current = rows.get(child.runId);
        if (!current || !isSameSubagentRunOwner(current, child)) {
          continue;
        }
        postimages.set(current.runId, {
          ...current,
          // Retires the obligation; the completion and delivery payload stay for operators.
          suppressCompletionDelivery: true,
          requesterSettleWake: undefined,
          delivery: {
            ...current.delivery,
            status: "discarded",
            discardedAt: now,
            queueId: undefined,
            nextAttemptAt: undefined,
            lastError: "Restart recovery refused: the requester's access has ended.",
          },
        });
      }
      return { value: undefined, postimages };
    },
    { assertCurrent },
  );
  return refused.length - recent.length;
}
