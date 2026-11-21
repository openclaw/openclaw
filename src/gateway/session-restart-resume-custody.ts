import { resolveSubagentCompletionParticipation } from "../agents/subagents/registry/subagent-child-owner-match.js";
import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { owesRequesterCompletion } from "../agents/subagents/registry/subagent-requester-settle-identity.js";
import { isYieldedSubagentRun } from "../agents/subagents/registry/subagent-run-liveness.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { readSessionSubmittedInput } from "../config/sessions/session-pending-input-source.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
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
import { ADMIN_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { prepareSessionParticipationRun } from "./session-principal-run-authority.js";
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
): Promise<{ assertCurrent: () => void; resume: () => void }> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  assertCurrent();
  const recovered: string[] = [];
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
        })),
      );
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
    }
  }
  return {
    assertCurrent,
    resume: () => {
      signal.throwIfAborted();
      if (!isGatewayRestartDraining()) {
        for (const runId of recovered) {
          resumeSubagentRun(runId);
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
}): Promise<string[]> {
  const { context, entry, agentId, sessionKey, storePath, assertCurrent } = params;
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
  let authority: Awaited<ReturnType<typeof prepareSessionSystemTurnAuthority>>;
  let target: TranscriptLease | undefined;
  try {
    target = await acquireTranscriptLease(
      chatRef({ agentId, sessionKey, storePath }),
      { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
      { env: params.env },
    );
    const requester = target;
    await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, async () => {
      for (const child of pending) {
        const childEntry = await readSessionEntryReadOnlyInWorker(
          {
            agentId: child.childAgentId ?? agentId,
            sessionKey: child.childSessionKey,
          },
          assertCurrent,
        );
        const participant = await prepareSessionParticipationRun({
          context,
          agentId,
          entry: childEntry,
          turnCeiling: resolveSubagentCompletionParticipation([child], childEntry),
          assertCurrent,
        });
        try {
          if (!participant && !authority) {
            authority = await prepareSessionSystemTurnAuthority({
              context,
              agentId,
              sessionKey,
              storePath,
              sessionId: entry.sessionId,
              preserveRecordedSource: true,
              assertCurrent,
            });
          }
          const selected = participant ?? authority;
          await withOperatorToolGatewayAuthority(
            {
              operatorRunAuthority: selected?.authority,
              operatorRoleActor: { kind: "system" },
              scopes: selected?.authority.scopes ?? [ADMIN_SCOPE],
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
          );
        } finally {
          participant?.release();
        }
      }
    });
  } finally {
    target?.release();
    authority?.release();
  }
  return pending.map((child) => child.runId);
}
