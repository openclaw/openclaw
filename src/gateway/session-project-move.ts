import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { listProjectRegistry } from "../projects/project-registry.js";
import {
  filterProjectsForRequester,
  hasFullProjectAccess,
  resolveRequesterProject,
  type ProjectRequester,
} from "./project-access.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { prepareSessionWorkspaceForRun } from "./server-methods/session-create-project.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionFileWorkspace } from "./session-file-workspace.js";
import { resolveSessionProjectRootForRecord } from "./session-project-source.js";
import { isSessionOwnRequester } from "./session-sharing-policy.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { describeSessionWorkspaceBlocker } from "./session-work-blocker.js";
import {
  deleteCarryRef,
  importCarriedWork,
  type CarrySource,
  type ImportedWork,
} from "./session-workspace-carry.js";

/** Who asks: the operator driving the run, or the Gateway itself for owner runs. */
export type SessionProjectRequester =
  | { profileId: string | undefined; scopes: readonly string[] }
  | undefined;

function projectRequester(requester: SessionProjectRequester): ProjectRequester {
  return requester ? { kind: "operator", scopes: requester.scopes } : { kind: "internal" };
}

/** Registered projects this requester may move a conversation into. */
export async function listSessionProjects(
  context: GatewayRequestContext,
  requester: SessionProjectRequester,
) {
  const cfg = context.getRuntimeConfig();
  // An unbound conversation already works in its agent workspace.
  const registered = (await listProjectRegistry(cfg)).filter(
    (project) => project.source !== "workspace",
  );
  const projects = await filterProjectsForRequester(cfg, registered, projectRequester(requester));
  return projects.map(({ id, displayName, originUrl }) =>
    originUrl ? { id, name: displayName, originUrl } : { id, name: displayName },
  );
}

function isUnbound(entry: Partial<InternalSessionEntry>, workspaceDir: string) {
  return !(
    entry.worktree ||
    entry.repositoryWorkspaceId ||
    entry.projectId ||
    entry.deviceFolder ||
    entry.execNode ||
    entry.pendingWorktree ||
    entry.pendingProjectGitUrl ||
    (entry.sessionRoot !== undefined && entry.sessionRoot !== workspaceDir)
  );
}

/**
 * Record a project and a pending checkout on a conversation that has neither. The
 * session's next turn opens the checkout through the same preparation as a session
 * created in the project; a named checkout's commit and unsaved files come along.
 */
export async function moveSessionIntoProject(params: {
  context: GatewayRequestContext;
  session: { agentId: string; sessionKey: string };
  /** Where the conversation's files live; the checkout's Git commands run there. */
  carrySource: CarrySource;
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
  if (!isUnbound(entry, workspaceDir)) {
    // A retried move of the same conversation returns its recorded intent.
    if (
      entry.projectId === params.projectId &&
      entry.pendingWorktree?.source?.id === params.projectId
    ) {
      return { status: "pending" as const, projectId: params.projectId };
    }
    throw new Error(
      "This conversation already has a project or workspace, and a conversation moves into a project only once. Start a new session in the project instead (sessions_spawn with visible=true and projectId); nothing was moved.",
    );
  }
  const access = projectRequester(requester);
  if (
    requester &&
    !hasFullProjectAccess(access) &&
    !isSessionOwnRequester(
      { cfg, client: null },
      { canonicalKey: loaded.canonicalKey, entry },
      requester.profileId,
    )
  ) {
    throw new Error(
      "Only the person who started this conversation, or someone with full operator write permission, can move it into a project.",
    );
  }
  const assertCurrent = () => {
    signal?.throwIfAborted();
    params.assertCurrent();
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
  const project = await resolveRequesterProject(cfg, params.projectId, access, { fresh: true });
  if (!project || project.source === "workspace") {
    throw new Error(`Project ${params.projectId} is not available to you; nothing was moved.`);
  }
  const projectRoot = await resolveSessionProjectRootForRecord(project, true);
  if (!projectRoot.ok) {
    throw new Error(projectRoot.error.message);
  }
  // Earlier messages keep opening the files they named in the original workspace.
  const oldFiles = await prepareSessionFileWorkspace(cfg, target.agentId, target.sessionKey, entry);
  const facts = await readSessionTranscriptAnchorsAsync(
    { ...target, sessionId: entry.sessionId },
    { entryIds: [], includeWatermark: true },
    signal,
  );
  if (!oldFiles.root || !facts.watermark) {
    throw new Error("The conversation's earlier files are unavailable; retry the move.");
  }
  assertCurrent();
  const carried: ImportedWork | undefined = params.checkout
    ? await importCarriedWork({
        source: params.carrySource,
        checkout: params.checkout,
        projectRoot: projectRoot.value,
        refName: `refs/openclaw/carry/${entry.sessionId}`,
        signal,
        assertCurrent,
      })
    : undefined;
  // Accepted edge case: a move recorded but never opened leaves its carry ref behind.
  const recorded = await patchSessionEntryCore(
    target,
    (current) => {
      assertCurrent();
      if (!isUnbound(current, workspaceDir)) {
        throw new Error("This conversation already has a project or workspace; nothing was moved.");
      }
      oldFiles.assertCurrent(context.getRuntimeConfig(), current);
      return {
        projectId: project.id,
        pendingWorktree: {
          workspace: projectRoot.value,
          source: { kind: "project", id: project.id },
          ...(carried ? { baseCommit: carried.commit } : {}),
          titleSource: "",
          ...(carried ? { carried: { ref: carried.refName, work: carried.work } } : {}),
          prior: {
            workspaceDir,
            fileRoot: oldFiles.root!,
            through: facts.watermark!,
          },
        },
      };
    },
    { requireWriteSuccess: true, skipMaintenance: true },
  ).catch(async (error: unknown) => {
    if (carried) {
      await deleteCarryRef(projectRoot.value, carried.refName);
    }
    throw error;
  });
  if (!recorded) {
    throw new Error("The conversation disappeared during the project move; nothing was moved.");
  }
  emitSessionsChanged(context, { ...target, reason: "project" });
  return {
    status: "pending" as const,
    projectId: project.id,
    ...(carried ? { carried: { commit: carried.commit, unsavedFiles: carried.unsavedFiles } } : {}),
  };
}

/**
 * Open a recorded move now, through the same preparation a session's next chat turn
 * runs, for callers whose next turn does not prepare workspaces. Returns the new branch.
 */
export async function openMovedSession(params: {
  context: GatewayRequestContext;
  session: { agentId: string; sessionKey: string };
  runId: string;
  runSetupScript: boolean;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const cfg = params.context.getRuntimeConfig();
  const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
    cfg,
    agentId: params.session.agentId,
    key: params.session.sessionKey,
    projection: "full",
  });
  const entry = loaded.entry;
  if (!entry) {
    throw new Error("This conversation could not be found.");
  }
  if (entry.pendingWorktree) {
    await prepareSessionWorkspaceForRun({
      entry,
      cfg,
      agentId: loaded.agentId,
      runId: params.runId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.storePath,
      context: params.context,
      signal: params.signal ?? new AbortController().signal,
      assertCurrent: params.assertCurrent,
      runSetupScript: params.runSetupScript,
    });
  }
  return entry.worktree?.branch;
}
