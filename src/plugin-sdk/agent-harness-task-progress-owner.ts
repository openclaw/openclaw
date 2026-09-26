import { resolveRequesterStoreKey } from "../agents/subagents/announce/subagent-requester-store-key.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  listAgentRunsForSession,
} from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { AgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { readTaskBackingInstance } from "../tasks/task-backing-authority.js";
import { registerHarnessTaskProgress } from "../tasks/task-registry-harness-progress.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export type AgentHarnessProgressOwnerRequest = {
  runIds: string[];
  agentId?: string;
  isCurrent: () => boolean;
  onStopped: () => void;
};

/** Bind post-yield presentation to the host-issued requester lifecycle and task rows. */
export function registerAgentHarnessTaskProgressOwner({
  scope,
  requesterSessionKey,
  scopedTasks,
  assertRunId,
  progress,
}: {
  scope: AgentHarnessTaskRuntimeScope;
  requesterSessionKey: string;
  scopedTasks: () => TaskRecord[];
  assertRunId: (runId: string) => void;
  progress: AgentHarnessProgressOwnerRequest;
}) {
  const sessionId = scope.requesterSessionId;
  const lifecycleRevision = scope.requesterLifecycleRevision;
  const agentId = scope.requesterAgentId;
  if (
    !sessionId ||
    !lifecycleRevision ||
    !agentId ||
    (progress.agentId && progress.agentId !== agentId)
  ) {
    return undefined;
  }
  const cfg = getRuntimeConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey, agentId);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  const readRuns = () =>
    listAgentRunsForSession({ sessionKey: canonicalKey, sessionId }).filter(
      ({ runId }) => getAgentRunContext(runId)?.projectSessionLifecycle !== false,
    );
  const originalRuns = new Map(
    readRuns().map(({ runId }) => {
      const context = getAgentRunContext(runId);
      return [runId, { context, claimId: context?.executionClaimId }] as const;
    }),
  );
  let retired = false;
  let unsubscribe: (() => void) | undefined;
  // Host run registration, not a provider thread, owns requester resumption.
  // Latch retirement so finishing the new turn cannot revive the old card.
  const isRequesterCurrent = () => {
    if (retired) {
      return false;
    }
    const valid =
      getAgentRunLifecycleGeneration() === lifecycleGeneration &&
      readRuns().every(({ runId }) => {
        const original = originalRuns.get(runId);
        const current = getAgentRunContext(runId);
        return original?.context === current && original?.claimId === current?.executionClaimId;
      });
    if (!valid) {
      retired = true;
    }
    return valid;
  };
  for (const runId of progress.runIds) {
    assertRunId(runId);
  }
  const ids = new Set(progress.runIds);
  const captured = new Map(
    scopedTasks()
      .filter((task) => ids.has(task.runId ?? ""))
      .map((task) => [
        task.taskId,
        {
          runId: task.runId,
          backing: JSON.stringify(readTaskBackingInstance(task.detail)),
          createdAt: task.createdAt,
        },
      ]),
  );
  const origin = scope.requesterOrigin ? { ...scope.requesterOrigin } : undefined;
  const registration = registerHarnessTaskProgress({
    owner: {
      sessionKey: requesterSessionKey,
      requesterOrigin: origin,
      agentId,
    },
    readTasks: () =>
      scopedTasks().filter((task) => {
        const original = captured.get(task.taskId);
        return (
          original?.runId === task.runId &&
          original?.createdAt === task.createdAt &&
          original?.backing === JSON.stringify(readTaskBackingInstance(task.detail))
        );
      }),
    isCurrent: () => isRequesterCurrent() && progress.isCurrent(),
    verifyRequester: async (assertCurrent) => {
      try {
        const matches = await withSessionEntryReadOnlyInWorker(
          { agentId, sessionKey: canonicalKey, storePath, readConsistency: "latest" },
          assertCurrent,
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            return (
              read.value?.sessionId === sessionId &&
              read.value.lifecycleRevision === lifecycleRevision
            );
          },
        );
        if (!matches) {
          retired = true;
        }
        return matches;
      } catch {
        retired = true;
        return false;
      }
    },
    onStopped: () => {
      retired = true;
      unsubscribe?.();
      progress.onStopped();
    },
  });
  if (registration) {
    unsubscribe = sessionChanges.subscribeFacts((change) => {
      if (
        "all" in change
          ? (typeof change.scope === "string"
              ? change.scope === "stores" || change.scope === "sessions"
              : change.scope.agentId === undefined || change.scope.agentId === agentId) ||
            !isRequesterCurrent()
          : change.sessionKey === canonicalKey &&
            (change.factsInvalidated ||
              change.facts?.kind === "removed" ||
              (change.facts?.kind === "entry" &&
                (change.facts.sessionId !== sessionId ||
                  change.facts.lifecycleRevision !== lifecycleRevision)) ||
              !isRequesterCurrent())
      ) {
        registration.dispose();
      }
    });
  }
  return registration;
}
