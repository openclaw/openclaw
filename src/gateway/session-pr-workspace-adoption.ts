import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { listExecSessionsForCancellation } from "../agents/bash-process-registry.js";
import { assertLocalSandboxWorkspaceBackend } from "../agents/sandbox/local-workspace.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { captureWorkspaceStateFilesystemGuard } from "../agents/workspace-state-guard.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  hasSessionControllerQueuedWork,
  isCompetingSessionControllerWorkActive,
} from "../sessions/session-controller.context.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionFileWorkspace } from "./session-file-workspace.js";
import { commitPreparedSessionWorkspace } from "./session-lifecycle-preparation.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

/** The yielded caller owns admission; siblings keep their original shared source. */
export async function adoptUnboundPullRequestWorkspace(params: {
  context: GatewayRequestContext;
  target: { agentId: string; sessionKey: string; storePath: string };
  entry: InternalSessionEntry;
  sandbox: SandboxContext;
  assertCurrent: () => void;
  verifyBeforeBinding: () => Promise<void>;
  signal?: AbortSignal;
}) {
  const { context, target, entry, sandbox } = params;
  assertLocalSandboxWorkspaceBackend(sandbox.backendId);
  const cfg = context.getRuntimeConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, target.agentId);
  const prior = entry.priorWorkspace;
  const recovering =
    prior?.worktreeId === entry.worktree?.id &&
    prior?.sessionId === entry.sessionId &&
    prior?.fileRoot === sandbox.workspaceDir;
  if (
    !recovering &&
    (entry.worktree ||
      entry.repositoryWorkspaceId ||
      entry.projectId ||
      entry.deviceFolder ||
      entry.execNode ||
      entry.spawnedCwd ||
      entry.spawnedWorkspaceDir ||
      entry.pendingWorktree ||
      entry.pendingProjectGitUrl ||
      (entry.sessionRoot !== undefined &&
        entry.sessionRoot !== workspaceDir &&
        entry.sessionRoot !== resolveCanonicalWorkspacePath(workspaceDir)))
  ) {
    throw new Error("This conversation already has another source. Its files were preserved.");
  }
  const assertWorkspaceCurrent = captureWorkspaceStateFilesystemGuard(workspaceDir, false);
  const identities = [target.sessionKey, entry.sessionId];
  const assertIdle = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
    assertWorkspaceCurrent();
    const busy =
      hasSessionControllerQueuedWork(target.storePath, identities, target.agentId) ||
      isCompetingSessionControllerWorkActive(target.storePath, identities, target.agentId) ||
      isCompetingSessionControllerWorkActive(
        `agent:${target.agentId}`,
        identities,
        target.agentId,
      ) ||
      listExecSessionsForCancellation().some(
        (process) =>
          process.agentId === target.agentId &&
          (process.sessionKey === target.sessionKey || process.scopeKey === target.sessionKey) &&
          (!process.exited ||
            process.finalizing ||
            process.cleanupUncertain ||
            process.finalizationFailed ||
            (process.backgrounded && !process.terminalPollObserved && !process.requestCancelled)),
      ) ||
      listSubagentRunsForRequester(target.sessionKey, {
        requesterSessionId: entry.sessionId,
        requesterLifecycleRevision: entry.lifecycleRevision,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
      }).some(
        (child) =>
          child.execution.endedAt === undefined ||
          child.killReconciliation ||
          child.requesterSettleWake ||
          child.delivery?.status === "pending" ||
          child.delivery?.status === "in_progress",
      ) ||
      Boolean(
        context.terminalSessions?.listAgent({
          kind: "agent",
          agentId: target.agentId,
          agentSessionKey: target.sessionKey,
          agentSessionId: entry.sessionId,
        }).length,
      );
    if (busy) {
      throw new Error(
        "This conversation still has queued input, background work, a child or a terminal. Finish or observe that work, then retry prepare_pr; nothing was stopped or moved.",
      );
    }
  };
  assertIdle();
  if (recovering) {
    return entry;
  }
  return runSessionMutation({
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      incarnation: entry.sessionId,
    }),
    policy: "allow-live",
    signal: params.signal,
    assertCurrent: assertIdle,
    prepare: async () => assertIdle(),
    run: async () => {
      const oldFiles = await prepareSessionFileWorkspace(
        cfg,
        target.agentId,
        target.sessionKey,
        entry,
      );
      assertIdle();
      if (!oldFiles.root || oldFiles.root !== sandbox.workspaceDir) {
        throw new Error(
          "The conversation's source changed before PR preparation; retry in its current workspace.",
        );
      }
      const facts = await readSessionTranscriptAnchorsAsync(
        {
          ...target,
          sessionId: entry.sessionId,
        },
        { entryIds: [], includeWatermark: true },
        params.signal,
      );
      assertIdle();
      if (!facts.watermark) {
        throw new Error(
          "The conversation's message boundary is unavailable; retry PR preparation.",
        );
      }
      const prepared = await prepareSessionWorktree({
        cfg,
        target: { ...target, key: target.sessionKey, entry },
        workspace: { kind: "empty" },
        runSetupScript: false,
        signal: params.signal,
        commitGuard: assertIdle,
      });
      if (!prepared.ok) {
        throw new Error(prepared.error.message);
      }
      const worktree = prepared.value.worktree;
      if (!worktree) {
        await prepared.value.rollback?.();
        throw new Error("PR preparation did not allocate a managed workspace.");
      }
      try {
        await params.verifyBeforeBinding();
        assertIdle();
      } catch (error) {
        await prepared.value.rollback?.();
        throw error;
      }
      const bound = await commitPreparedSessionWorkspace({
        prepared: prepared.value,
        priorWorkspace: {
          worktreeId: worktree.id,
          sessionId: entry.sessionId,
          workspaceDir,
          fileRoot: oldFiles.root,
          through: facts.watermark,
        },
        target,
        assertCurrent: assertIdle,
        assertEntry: (current) => {
          if (
            current.sessionId !== entry.sessionId ||
            current.lifecycleRevision !== entry.lifecycleRevision ||
            current.worktree ||
            current.repositoryWorkspaceId ||
            current.projectId ||
            current.spawnedCwd ||
            current.spawnedWorkspaceDir ||
            current.pendingWorktree ||
            current.pendingProjectGitUrl ||
            current.sessionRoot !== entry.sessionRoot
          ) {
            throw new Error("The conversation's source changed during PR preparation.");
          }
          oldFiles.assertCurrent(context.getRuntimeConfig(), current);
        },
        missingSessionMessage: "The conversation disappeared during PR preparation.",
      });
      params.assertCurrent();
      emitSessionsChanged(context, { ...target, reason: "project" });
      return bound;
    },
  });
}
