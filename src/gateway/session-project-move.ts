import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../config/sessions/session-entry-current-check.js";
import { isUnboundProjectSession } from "../config/sessions/session-project-eligibility.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  captureSessionTarget,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import type { SkillSnapshot } from "../skills/types.js";
import { resolveRequesterProject } from "./project-access.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { assertRequiredWorkerSessionCreateCurrent } from "./server-methods/session-create-required-worker.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionFileWorkspace } from "./session-file-workspace.js";
import { commitPreparedSessionWorkspace } from "./session-lifecycle-preparation.js";
import {
  canChooseSessionProject,
  describeSessionProjectSandboxBlocker,
  projectRequester,
  type SessionProjectRequester,
} from "./session-project-move-policy.js";
import { resolveSessionProjectRootForRecord } from "./session-project-source.js";
import { resolveExplicitSessionName } from "./session-title-state.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { describeSessionWorkspaceBlocker } from "./session-work-blocker.js";
import {
  applyUnsavedWork,
  deleteCarryRef,
  importCarriedWork,
  type CarrySource,
} from "./session-workspace-carry.js";
import {
  canRunSessionWorktreeSetup,
  prepareSessionWorktree,
} from "./session-worktree-preparation.js";

/** Prepare the checkout under the mover's authority, then publish the project and file roots together. */
export async function moveSessionIntoProject(params: {
  context: GatewayRequestContext;
  session: { agentId: string; sessionKey: string };
  /** Where the conversation's files live; the checkout's Git commands run there. */
  carrySource:
    | CarrySource
    | ((scope: {
        assertCurrent: () => void;
        skillsSnapshot?: SkillSnapshot;
      }) => Promise<Disposable & { source: CarrySource }>);
  projectId: string;
  /** Folder in the conversation's workspace whose commit and unsaved files come along. */
  checkout?: string;
  requester: SessionProjectRequester;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const { context, requester, signal } = params;
  const cfg = context.getRuntimeConfig();
  const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg,
    agentId: params.session.agentId,
    key: params.session.sessionKey,
    projection: "full",
  });
  const entry = loaded.entry;
  if (!entry) {
    throw new Error("This conversation could not be found; nothing was moved.");
  }
  const target = {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  };
  const workspaceDir = resolveAgentWorkspaceDir(cfg, target.agentId);
  const assertUnbound = (current: InternalSessionEntry | undefined) => {
    if (!current || !isUnboundProjectSession(current, target.agentId, workspaceDir)) {
      throw new Error(
        "This conversation already has a project or workspace, and a conversation moves into a project only once. Start a new session in the project instead (sessions_spawn with visible=true and projectId); nothing was moved.",
      );
    }
  };
  assertUnbound(entry);
  const access = projectRequester(requester);
  if (!canChooseSessionProject(cfg, loaded.canonicalKey, entry, requester)) {
    throw new Error(
      "Only the person who started this conversation, or someone with full operator write permission, can move it into a project.",
    );
  }
  const sandboxBlocker = describeSessionProjectSandboxBlocker(cfg, target, entry);
  if (sandboxBlocker) {
    throw new Error(sandboxBlocker);
  }
  const requiredProfile = cfg.cloudWorkers?.requiredProfile;
  const projectSelection = { projectId: params.projectId, worktree: true };
  const runSetupScript = canRunSessionWorktreeSetup(requiredProfile, requester?.scopes);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    params.assertCurrent();
    assertRequiredWorkerSessionCreateCurrent(
      context.getRuntimeConfig(),
      requiredProfile,
      projectSelection,
    );
    const blocker = describeSessionWorkspaceBlocker({
      context,
      target,
      sessionId: entry.sessionId,
    });
    if (blocker) {
      throw new Error(
        `This conversation still has background work, a child or a terminal: ${blocker}. Finish that work, then move again; nothing was stopped or moved.`,
      );
    }
  };
  assertCurrent();
  return runSessionMutation({
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      incarnation: entry.sessionId,
    }),
    policy: "allow-live",
    signal,
    assertCurrent,
    run: async () => {
      using resources = new DisposableStack();
      const selected = await captureSessionEntryCurrentCheckAsyncInternal({
        ...target,
        expected: { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
        // Workspace eligibility needs the full row.
        fields: [],
        errorMessage: "The conversation changed while preparing its checkout; retry the move.",
      });
      resources.defer(selected.release);
      assertCurrent();
      assertUnbound(selected.entry);
      const project = await resolveRequesterProject(cfg, params.projectId, access, { fresh: true });
      if (!project || project.source === "workspace") {
        throw new Error(`Project ${params.projectId} is not available to you; nothing was moved.`);
      }
      const projectRoot = await resolveSessionProjectRootForRecord(project, true);
      if (!projectRoot.ok) {
        throw new Error(projectRoot.error.message);
      }
      // Earlier messages keep opening the files they named in the original workspace.
      const oldFiles = await prepareSessionFileWorkspace(
        cfg,
        target.agentId,
        target.sessionKey,
        entry,
      );
      const { watermark } = await readSessionTranscriptAnchorsAsync(
        { ...target, sessionId: entry.sessionId },
        { entryIds: [], includeWatermark: true },
        signal,
      );
      const fileRoot = oldFiles.root;
      if (!fileRoot || !watermark) {
        throw new Error("The conversation's earlier files are unavailable; retry the move.");
      }
      assertCurrent();
      const source = params.carrySource;
      const carried = params.checkout
        ? await importCarriedWork({
            source:
              typeof source === "function"
                ? resources.use(
                    await source({ assertCurrent, skillsSnapshot: entry.skillsSnapshot }),
                  ).source
                : source,
            checkout: params.checkout,
            projectRoot: projectRoot.value,
            refName: `refs/openclaw/carry/${entry.sessionId}`,
            signal,
            assertCurrent,
          })
        : undefined;
      try {
        const prepared = await prepareSessionWorktree({
          cfg,
          target: {
            ...target,
            key: target.sessionKey,
            entry,
            projectId: project.id,
            sandboxRequired: entry.sandbox === "required",
          },
          workspace: projectRoot.value,
          acceptedSource: { kind: "project", id: project.id },
          checkoutCommit: carried?.commit,
          label: resolveExplicitSessionName(entry),
          runSetupScript,
          signal,
          commitGuard: assertCurrent,
          prepareCheckout: carried
            ? (worktreePath, guard) => applyUnsavedWork(carried.work, worktreePath, guard)
            : undefined,
        });
        if (!prepared.ok) {
          throw new Error(prepared.error.message);
        }
        const worktree = prepared.value.worktree;
        if (!worktree) {
          await prepared.value.rollback?.();
          throw new Error("The project checkout was not allocated.");
        }
        await commitPreparedSessionWorkspace({
          prepared: prepared.value,
          projectId: project.id,
          priorWorkspace: {
            sessionId: entry.sessionId,
            worktreeId: worktree.id,
            workspaceDir,
            fileRoot,
            through: watermark,
          },
          target,
          signal,
          assertCurrent: composeSessionSourceAssertion([assertCurrent, selected.source]),
          assertEntry: (current) => {
            assertUnbound(current);
            oldFiles.assertCurrent(context.getRuntimeConfig(), current);
          },
          missingSessionMessage: "The conversation disappeared during the project move.",
        });
        emitSessionsChanged(context, { ...target, reason: "project" });
        return {
          status: "moved" as const,
          projectId: project.id,
          branch: worktree.branch,
          ...(carried
            ? { carried: { commit: carried.commit, unsavedFiles: carried.unsavedFiles } }
            : {}),
        };
      } finally {
        if (carried) {
          await deleteCarryRef(projectRoot.value, carried.refName);
        }
      }
    },
  });
}
