import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
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
import { readSessionSubmittedInput } from "../config/sessions/session-pending-input-source.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionPendingInputRow } from "../config/sessions/session-pending-input.types.js";
import { isRestartResumeEntryOutOfScope } from "../config/sessions/session-restart-resume-scope.js";
import {
  acquireTranscriptLease,
  type TranscriptLease,
} from "../config/sessions/transcript-lease.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
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
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

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
  for (const { sessionKey, entry } of entries) {
    // A completion wakes parent work; work from another restart resume scope never regains it.
    if (isRestartResumeEntryOutOfScope(entry)) {
      continue;
    }
    try {
      recovered.push(
        ...(await recoverRequesterCompletionCustody({
          context,
          ...target,
          sessionKey,
          entry,
          agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
          assertCurrent,
          log,
        })),
      );
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
    }
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
}): Promise<SubagentRunRecord[]> {
  const { context, entry, agentId, sessionKey, storePath, assertCurrent, log } = params;
  if (entry.archivedAt !== undefined) {
    return [];
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
    return [];
  }
  const recovered: SubagentRunRecord[] = [];
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
      } finally {
        authority?.release();
      }
    }
  } finally {
    target?.release();
  }
  return recovered;
}
