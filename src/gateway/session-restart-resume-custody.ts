import {
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "../agents/subagents/registry/subagent-registry-memory.js";
import { resumeSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import { owesRequesterCompletion } from "../agents/subagents/registry/subagent-requester-settle-identity.js";
import { isSameSubagentRunOwner } from "../agents/subagents/registry/subagent-run-generation.js";
import { isYieldedSubagentRun } from "../agents/subagents/registry/subagent-run-liveness.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { readSessionSubmittedInput } from "../config/sessions/session-pending-input-source.js";
import type { PendingInputScope } from "../config/sessions/session-pending-input-store.js";
import { isRestartResumeEntryOutOfScope } from "../config/sessions/session-restart-resume-scope.js";
import { releaseSessionSourceAuthorities } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  GatewayDrainingError,
  isGatewayRestartDraining,
} from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type {
  PreparedRestartStore,
  RestartResumeParams,
} from "./session-restart-resume-discovery.js";

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

/** Rebind retained completion routing without reviving wake sources before classification. */
export async function prepareRestartCompletionCustody(
  { context, signal, log }: RestartResumeParams,
  { target, entries }: Pick<PreparedRestartStore, "target" | "entries">,
): Promise<{ assertCurrent: () => void; resume: () => Promise<void> }> {
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (isGatewayRestartDraining()) {
      throw new GatewayDrainingError();
    }
  };
  assertCurrent();
  const recovered: Array<{ sessionKey: string; resume: () => Promise<void> }> = [];
  for (const { sessionKey, entry } of entries) {
    // A completion wakes parent work; work from another restart resume scope never regains it.
    if (isRestartResumeEntryOutOfScope(entry)) {
      continue;
    }
    try {
      const resume = await recoverRequesterCompletionCustody({
        context,
        ...target,
        sessionKey,
        entry,
        agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
        assertCurrent,
      });
      if (resume) {
        recovered.push({ sessionKey, resume });
      }
    } catch (error) {
      signal.throwIfAborted();
      log.warn(`Restart completion recovery failed for ${sessionKey}: ${String(error)}`);
    }
  }
  return {
    assertCurrent,
    resume: async () => {
      signal.throwIfAborted();
      if (isGatewayRestartDraining()) {
        return;
      }
      for (const recovery of recovered) {
        try {
          await recovery.resume();
        } catch (error) {
          signal.throwIfAborted();
          log.warn(
            `Restart completion recovery failed for ${recovery.sessionKey}: ${String(error)}`,
          );
        }
      }
    },
  };
}

/** Recover requester routing without rebuilding operator authority for owed results. */
async function recoverRequesterCompletionCustody(params: {
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "archivedAt">;
  assertCurrent: () => void;
}): Promise<(() => Promise<void>) | undefined> {
  const { context, entry, agentId, sessionKey, storePath, assertCurrent } = params;
  if (entry.archivedAt !== undefined) {
    return undefined;
  }
  const pending = [...getSubagentRunsForRequesterSession(sessionKey)].filter(
    (child) =>
      child.requesterAgentId === agentId &&
      subagentRuns.isExecutionRetired(child) &&
      ((isYieldedSubagentRun(child) && owesRequesterCompletion(child)) ||
        child.requesterSettleWake !== undefined ||
        child.delivery?.status === "pending" ||
        child.delivery?.status === "in_progress" ||
        child.delivery?.status === "failed"),
  );
  if (!pending.length) {
    return undefined;
  }
  const requesterSource = captureSessionEntrySourceAssertion({
    scope: { agentId, sessionKey, storePath, env: params.env },
    expected: entry,
    fields: ["sessionId", "lifecycleRevision", "archivedAt"],
    assertCurrent,
    assertHostCurrent: assertCurrent,
    refuse: () => {
      throw new Error("Restart completion requester is unavailable or has changed.");
    },
  });
  const withRequester = async (run: (assertRequesterCurrent: () => void) => void) => {
    const requester = await requesterSource.prepareSessionSource();
    try {
      assertCurrent();
      requester.assertCurrent();
      run(requester.assertCurrent);
    } finally {
      await releaseSessionSourceAuthorities([requester]);
    }
  };
  await withRequester((assertRequesterCurrent) => {
    for (const child of pending) {
      assertRequesterCurrent();
      if (!isSameSubagentRunOwner(subagentRuns.get(child.runId), child)) {
        throw new Error("Restart completion execution owner has changed.");
      }
      bindGatewayContextResolver(child, context.resolveGatewayContext);
    }
  });
  return () =>
    withRequester((assertRequesterCurrent) => {
      for (const child of pending) {
        assertRequesterCurrent();
        const current = subagentRuns.get(child.runId);
        if (!current || !isSameSubagentRunOwner(current, child)) {
          throw new Error("Restart completion execution owner has changed.");
        }
        // Root restart inputs must be admitted before these retired wake sources return.
        subagentRuns.reactivateExecution(current);
        resumeSubagentRun(current.runId);
      }
    });
}
