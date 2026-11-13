import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { listExecSessionsForCancellation } from "../agents/bash-process-registry.js";
import { assertLocalSandboxWorkspaceBackend } from "../agents/sandbox/local-workspace.js";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { captureWorkspaceStateFilesystemGuard } from "../agents/workspace-state-guard.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isCompetingSessionControllerWorkActive } from "../sessions/session-controller.context.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import type { ProjectRequester } from "./project-access.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionFileWorkspace } from "./session-file-workspace.js";
import { commitPreparedSessionWorkspace } from "./session-lifecycle-preparation.js";
import {
  resolvePullRequestProjectSource,
  resolveSessionProjectRootForRecord,
} from "./session-project-source.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

/** The yielded caller owns admission; siblings keep their original shared source. */
export async function adoptUnboundPullRequestWorkspace(params: {
  context: GatewayRequestContext;
  target: { agentId: string; sessionKey: string; storePath: string };
  entry: InternalSessionEntry;
  sandbox: SandboxContext;
  assertCurrent: () => void;
  verifyBeforeBinding?: () => Promise<void>;
  projectSource?: { host: string; repository: string; requester: ProjectRequester };
  signal?: AbortSignal;
}) {
  const { context, target, entry, sandbox } = params;
  assertLocalSandboxWorkspaceBackend(sandbox.backendId);
  const cfg = context.getRuntimeConfig();
  const workspaceDir = resolveAgentWorkspaceDir(cfg, target.agentId);
  const originalRoot = sandbox.workspaceDir;
  const prior = entry.priorWorkspace;
  const recovering =
    prior?.worktreeId === entry.worktree?.id &&
    prior?.sessionId === entry.sessionId &&
    prior?.fileRoot === originalRoot;
  if (
    !recovering &&
    (entry.worktree ||
      entry.repositoryWorkspaceId ||
      entry.projectId ||
      entry.deviceFolder ||
      entry.execNode ||
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
    // The handoff holds queued follow-ups; only competing execution blocks adoption.
    // An exited, finalized process cannot compete, and its output stays readable
    // through process log, so an unread result (including a requested stop) is not busy.
    const process = listExecSessionsForCancellation().find(
      (candidate) =>
        candidate.agentId === target.agentId &&
        (candidate.sessionKey === target.sessionKey || candidate.scopeKey === target.sessionKey) &&
        (!candidate.exited ||
          candidate.finalizing ||
          candidate.cleanupUncertain ||
          candidate.finalizationFailed),
    );
    const describeProcess = (exec: NonNullable<typeof process>) =>
      !exec.exited
        ? `background exec ${exec.id} is still running; poll or kill it`
        : exec.finalizing
          ? `background exec ${exec.id} is still cleaning up; poll it until it settles`
          : `background exec ${exec.id} could not confirm its cleanup; inspect it with process log`;
    const child = () =>
      listSubagentRunsForRequester(target.sessionKey, {
        requesterSessionId: entry.sessionId,
        requesterLifecycleRevision: entry.lifecycleRevision,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
      }).find(
        (run) =>
          run.execution.endedAt === undefined ||
          run.killReconciliation ||
          run.requesterSettleWake ||
          run.delivery?.status === "pending" ||
          run.delivery?.status === "in_progress",
      );
    const blockingChild = process ? undefined : child();
    const blocker = process
      ? describeProcess(process)
      : blockingChild
        ? `child ${blockingChild.childSessionKey} has not finished or delivered its result`
        : context.terminalSessions?.listAgent({
              kind: "agent",
              agentId: target.agentId,
              agentSessionKey: target.sessionKey,
              agentSessionId: entry.sessionId,
            }).length
          ? "a terminal is still open for this conversation"
          : isCompetingSessionControllerWorkActive(target.storePath, identities, target.agentId) ||
              isCompetingSessionControllerWorkActive(
                `agent:${target.agentId}`,
                identities,
                target.agentId,
              )
            ? "another run of this conversation is still active"
            : undefined;
    if (blocker) {
      throw new Error(
        `This conversation still has background work, a child or a terminal: ${blocker}. Finish that work, then retry workspace preparation; nothing was stopped or moved.`,
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
      if (!oldFiles.root || oldFiles.root !== originalRoot) {
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
      const source = params.projectSource;
      const project = source ? await resolvePullRequestProjectSource(cfg, source) : undefined;
      const projectRoot = project
        ? await resolveSessionProjectRootForRecord(project, true)
        : undefined;
      assertIdle();
      if (projectRoot && !projectRoot.ok) {
        throw new Error(projectRoot.error.message);
      }
      const prepared = await prepareSessionWorktree({
        cfg,
        target: {
          ...target,
          key: target.sessionKey,
          entry,
          projectId: project?.id,
          sandboxRequired: true,
        },
        workspace: projectRoot?.value ?? { kind: "empty" },
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
        await params.verifyBeforeBinding?.();
        assertIdle();
      } catch (error) {
        await prepared.value.rollback?.();
        throw error;
      }
      const bound = await commitPreparedSessionWorkspace({
        prepared: prepared.value,
        projectId: project?.id,
        signal: params.signal,
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
            current.spawnedCwd !== entry.spawnedCwd ||
            current.spawnedWorkspaceDir !== entry.spawnedWorkspaceDir ||
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
