import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { resolveSubagentChildAuthority } from "../agents/subagents/registry/subagent-child-owner-match.js";
import { isRestartInterruptedSubagent } from "../agents/subagents/registry/subagent-recovery-state.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  restoreSubagentRunsFromDisk,
} from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import {
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "../agents/subagents/registry/subagent-run-generation.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { SessionRecoverySourceChangedError } from "./session-recovery-source.js";

/** Retain the registry owner for explicit recovery, including terminal restart failures. */
export async function prepareSubagentRestartRecovery(params: {
  sessionKey: string;
  agentId: string;
  entry: InternalSessionEntry;
  assertCurrent?: () => void;
}): Promise<{ runId: string; assertCurrent: () => void } | undefined> {
  const terminalFailure = params.entry.status === "failed" && params.entry.abortedLastRun !== true;
  if (
    !terminalFailure &&
    (params.entry.status !== "interrupted" || params.entry.abortedLastRun !== true)
  ) {
    return undefined;
  }
  const observed = await getLatestSubagentRunByChildSessionKey(params.sessionKey, params.agentId);
  if (
    !observed ||
    !isRestartInterruptedSubagent(
      observed,
      terminalFailure ? { allowTerminalFailure: true } : undefined,
    ) ||
    (terminalFailure && observed.execution.interruptionReason !== undefined) ||
    resolveSubagentChildAuthority(observed, params.entry).status !== "verified" ||
    params.entry.lastRunId !== observed.runId
  ) {
    return undefined;
  }
  const latest = () =>
    getLatestLiveSubagentRunByChildSessionKey(params.sessionKey, undefined, params.agentId);
  if (!latest()) {
    await restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
      assertCurrent: params.assertCurrent,
    });
  }
  const interrupted = latest();
  return {
    runId: observed.runId,
    assertCurrent() {
      params.assertCurrent?.();
      const current = latest();
      if (
        !current ||
        !isSameSubagentRun(interrupted, observed) ||
        !isSameSubagentRunOwner(current, interrupted) ||
        !isRestartInterruptedSubagent(
          current,
          terminalFailure ? { allowTerminalFailure: true } : undefined,
        ) ||
        (terminalFailure && current.execution.interruptionReason !== undefined)
      ) {
        throw new SessionRecoverySourceChangedError();
      }
    },
  };
}

/** Persist the dispatched follow-up prompt so restart recovery cannot reuse the original task. */
export async function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
  task?: string;
  gatewayContextResolver?: GatewayContextResolver;
  assertCurrent?: () => void;
  session?: {
    cfg: OpenClawConfig;
    activeSessionAgentId: string;
    sessionEntry?: SessionEntry;
  };
  /** Continue only this yielded task; any other owner leaves the turn a separate follow-up. */
  expectedPausedRun?: SubagentRunRecord;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const admittedEntry = params.session?.sessionEntry;
  const sessionEntry = admittedEntry
    ? { sessionId: admittedEntry.sessionId, lifecycleRevision: admittedEntry.lifecycleRevision }
    : undefined;
  const paused = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    (entry) => entry.pauseReason === "sessions_yield",
  );
  if (
    params.expectedPausedRun &&
    (!isSameSubagentRunOwner(paused, params.expectedPausedRun) ||
      paused?.killIntent ||
      paused?.killReconciliation)
  ) {
    return false;
  }
  const existing = paused ?? (await getLatestSubagentRunByChildSessionKey(params.sessionKey));
  const continuesInterruptedTask =
    existing?.execution.status === "interrupted" && isRestartInterruptedSubagent(existing);
  if (!existing || (!continuesInterruptedTask && typeof existing.execution.endedAt !== "number")) {
    return false;
  }
  if (params.gatewayContextResolver && !params.gatewayContextResolver()) {
    return false;
  }
  if (params.session) {
    const [acpMeta] = await readAcpSessionMetaForEntries({
      cfg: params.session.cfg,
      entries: [
        {
          agentId: params.session.activeSessionAgentId,
          sessionKey: params.sessionKey,
          entry: params.session.sessionEntry,
        },
      ],
    });
    params.assertCurrent?.();
    if (acpMeta) {
      return false;
    }
  }
  const stateContext = captureOpenClawStateWorkerContext();
  const liveSource = () =>
    getLatestLiveSubagentRunByChildSessionKey(
      params.sessionKey,
      (entry) => entry.runId === existing.runId,
    );
  if (!liveSource()) {
    await restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
      context: stateContext,
      assertCurrent: params.assertCurrent,
    });
  }
  const source = liveSource();
  if (!source || !isSameSubagentRun(source, existing)) {
    return false;
  }
  const latest = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  const assertOriginalOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = liveSource();
    const currentLatest = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
    if (
      !isSameSubagentRunOwner(current, source) ||
      (latest ? !isSameSubagentRunOwner(currentLatest, latest) : currentLatest !== undefined) ||
      (current &&
        (continuesInterruptedTask
          ? current.execution.status !== "interrupted" || !isRestartInterruptedSubagent(current)
          : typeof current.execution.endedAt !== "number"))
    ) {
      throw new Error("subagent follow-up source changed while its writes settled");
    }
    params.assertCurrent?.();
    if (params.gatewayContextResolver && !params.gatewayContextResolver()) {
      throw new Error("subagent follow-up Gateway owner retired");
    }
  };
  const runtime = await import("../agents/subagents/registry/subagent-registry.js");
  assertOriginalOwnerCurrent();
  const task = params.task;
  const hasTask = typeof task === "string" && task.trim().length > 0;
  // A yielded child still owes its parent completion; operator follow-ups must
  // preserve that wake rather than treating the task as already completed.
  const gatewayBinding = params.gatewayContextResolver
    ? { gatewayContextResolver: params.gatewayContextResolver }
    : {};
  const replaced =
    source.pauseReason === "sessions_yield"
      ? await runtime.adoptPausedSubagentRunForFollowUp({
          childSessionKey: params.sessionKey,
          runId,
          ...(params.expectedPausedRun ? { expected: params.expectedPausedRun } : {}),
          task: hasTask ? task : source.task,
          assertCurrent: assertOriginalOwnerCurrent,
          ...gatewayBinding,
        })
      : await runtime.replaceSubagentRunAfterSteerCore({
          previousRunId: source.runId,
          nextRunId: runId,
          ...(continuesInterruptedTask
            ? { expected: source, preserveRequesterSettleWake: true }
            : { preserveCompletedRun: true, sessionEntry }),
          runTimeoutSeconds: source.runTimeoutSeconds ?? 0,
          ...(hasTask ? { task } : {}),
          assertCurrent: assertOriginalOwnerCurrent,
          ...gatewayBinding,
        });
  if (replaced) {
    return true;
  }
  const currentOwner = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  if (currentOwner?.runId === runId) {
    return true;
  }
  throw new Error("subagent follow-up owner replacement was rejected");
}
