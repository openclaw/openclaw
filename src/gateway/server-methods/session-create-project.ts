import { isDeepStrictEqual } from "node:util";
import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { materializeProjectClone, refreshProjectClone } from "../../projects/project-clone.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { resolveProjectDirectory } from "../../projects/project-registry.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { generateWorktreeSessionTitle } from "../dashboard-session-title.js";
import { githubApiToken } from "../github-public-api.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { prepareGatewayProjectGitHubIdentity } from "../project-github-identity.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "../session-create-service.types.js";
import { commitPreparedSessionWorkspace } from "../session-lifecycle-preparation.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { hasExplicitSessionName, resolveExplicitSessionName } from "../session-title-state.js";
import {
  prepareSessionWorktree,
  resolveSessionWorktreeBase,
} from "../session-worktree-preparation.js";
import { hasActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { prepareSessionCreateFilesystemRoot } from "./session-create-root.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const SESSION_PROJECT_OWNERSHIP_ERROR =
  "Session changed while preparing its project; retry the task.";
const workspacePreparations = new KeyedAsyncQueue();

type RepositorySource = NonNullable<SessionsCreateParams["repository"]>;

export function resolveSessionRepositoryCreation(
  params: SessionsCreateParams,
  hasInitialTurn: boolean,
): Result<RepositorySource | undefined, ErrorShape> {
  if (!params.repository) {
    return ok(undefined);
  }
  const url = normalizeSessionProjectGitUrl(params.repository.url);
  const ref = params.repository.ref?.trim();
  if (!url || (ref !== undefined && (!ref || ref.startsWith("-") || /\s|\0/u.test(ref)))) {
    return invalidSessionRequest(
      "Use a GitHub repository URL and a nonempty branch, tag, or commit ref.",
    );
  }
  if (
    params.cwd ||
    params.execNode ||
    params.projectId ||
    params.projectGitUrl ||
    params.worktree !== undefined ||
    params.worktreeBaseRef ||
    params.worktreeName ||
    params.catalogId
  ) {
    return invalidSessionRequest(
      "sessions.create repository cannot be combined with local workspace or catalog options.",
    );
  }
  if (hasInitialTurn) {
    return invalidSessionRequest(
      "Create the repository session without an initial turn, dispatch it with sessions.dispatch, then send the message with sessions.send.",
    );
  }
  return ok({ url, ...(ref ? { ref } : {}) });
}

export function prepareSessionRepositoryWorkspace(
  repository: RepositorySource,
  options: { runSetupScript: boolean; assertCurrent: () => void },
): PrepareGatewaySessionLifecycle {
  const { assertCurrent } = options;
  return async (target) => {
    const store = getSessionRepositoryWorkspaceStore();
    const source = captureOpenClawStateWorkerContext({ path: store.path });
    const assertSourceCurrent = () => {
      source.admission.assertCurrent();
      assertCurrent();
    };
    const existing = await store.find({ agentId: target.agentId, sessionKey: target.key });
    if (
      target.entry &&
      (!target.entry.repositoryWorkspaceId ||
        target.entry.repositoryWorkspaceId !== existing?.workspaceId)
    ) {
      return invalidSessionRequest("repository source requires a new repository session");
    }
    if (
      existing &&
      (existing.url !== repository.url || existing.requestedRef !== (repository.ref ?? null))
    ) {
      return invalidSessionRequest("session repository source cannot be changed");
    }
    assertSourceCurrent();
    const workspace = await store.create({
      agentId: target.agentId,
      sessionKey: target.key,
      url: repository.url,
      requestedRef: repository.ref,
      runSetupScript: options.runSetupScript,
      assertCurrent: assertSourceCurrent,
    });
    const withCommit: NonNullable<PreparedGatewaySessionLifecycle["withCommit"]> = (run) =>
      runOpenClawStateWorkerOperation(source, () => run(assertSourceCurrent), {
        assertCurrent: assertSourceCurrent,
      });
    return ok({
      repositoryWorkspaceId: workspace.workspaceId,
      withCommit,
      ...(!existing
        ? {
            rollback: async () => {
              // Creation still holds the session lifecycle lock. Cleanup owns only the
              // untouched row it allocated, even when the initiating caller has gone away.
              source.admission.assertCurrent();
              const prepared = await store.prepare(workspace.workspaceId);
              await store.delete({
                workspaceId: workspace.workspaceId,
                assertCurrent: () => {
                  source.admission.assertCurrent();
                  const current = prepared.current();
                  if (
                    current &&
                    (current.agentId !== target.agentId ||
                      current.sessionKey !== target.key ||
                      current.revision !== workspace.revision)
                  ) {
                    throw new Error("Repository preparation changed before rollback");
                  }
                },
              });
            },
          }
        : {}),
    });
  };
}

export function normalizeSessionProjectGitUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 2048
    ? parseConfiguredProjectGitUrl(value)?.url
    : undefined;
}

export function validateSessionProjectPreparation(params: {
  cwd?: string;
  execNode?: string;
  gitUrl?: string;
  hasInitialTurn: boolean;
  projectId?: string;
}): ErrorShape | undefined {
  if (!params.gitUrl) {
    return params.projectId && (params.cwd || params.execNode)
      ? errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create projectId cannot be combined with cwd or execNode",
        )
      : undefined;
  }
  if (!normalizeSessionProjectGitUrl(params.gitUrl)) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    );
  }
  if (params.projectId || params.cwd || params.execNode) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create projectGitUrl cannot be combined with projectId, cwd, or execNode",
    );
  }
  return params.hasInitialTurn
    ? undefined
    : errorShape(
        ErrorCodes.INVALID_REQUEST,
        "sessions.create projectGitUrl requires an initial turn",
      );
}

/** Bind persisted workspace intent only while its exact admitted run remains authoritative. */
export async function prepareSessionWorkspace(params: {
  admission: AdmittedChatSend;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  session: PreparedChatSendSession;
}): Promise<() => void> {
  const { admission, client, context, session } = params;
  const { entry, clientRunId, sessionKey } = session;
  if (!entry) {
    throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
  }
  const { controller } = admission.activeRunAbort;
  const signal = controller.signal;
  const assertRunOwnership = () => {
    signal.throwIfAborted();
    const activeRun = context.chatAbortControllers.get(clientRunId);
    if (
      !activeRun ||
      activeRun !== admission.activeRunAbort.entry ||
      activeRun.controller !== controller ||
      activeRun.sessionKey !== sessionKey ||
      activeRun.sessionId !== entry.sessionId ||
      entry.sessionId !== admission.admittedSessionId ||
      activeRun.lifecycleGeneration !== admission.lifecycleGeneration ||
      activeRun.projectSessionActive === false ||
      activeRun.projectSessionTerminalPending === true ||
      activeRun.projectSessionTerminalPersisted === true ||
      !hasActiveAgentRuntimeAuthority(client, context)
    ) {
      throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
    }
    assertAgentRunLifecycleGenerationCurrent(admission.lifecycleGeneration);
  };
  await prepareSessionWorkspaceForRun({
    ...session,
    entry,
    runId: clientRunId,
    context,
    signal,
    assertCurrent: assertRunOwnership,
    runSetupScript: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
  });
  return assertRunOwnership;
}

/** The admitted turn supplies authority; this owner prepares and binds its saved workspace. */
export async function prepareSessionWorkspaceForRun(params: {
  entry: InternalSessionEntry;
  cfg: OpenClawConfig;
  agentId: string;
  runId: string;
  sessionKey: string;
  storePath: string;
  context: Parameters<typeof emitSessionsChanged>[0] &
    Pick<GatewayRequestHandlerOptions["context"], "logGateway">;
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  runSetupScript: boolean;
}): Promise<void> {
  const {
    entry,
    cfg,
    agentId,
    runId: clientRunId,
    sessionKey,
    storePath,
    context,
    signal,
  } = params;
  const target = { agentId, sessionKey, storePath };
  const metadata = captureSessionEntryMetadataRead(target, params.assertCurrent);
  const assertRunOwnership = composeSessionSourceAssertion(
    [params.assertCurrent],
    (assertSources) => {
      signal.throwIfAborted();
      assertSources();
      metadata?.assertCurrent();
    },
  );
  assertRunOwnership();
  emitAgentRunStatusEvent({
    runId: clientRunId,
    sessionKey,
    agentId,
    phase: "preparing_workspace",
  });
  // Serialize through binding/rollback, not just Git allocation. A second send
  // must never roll back a checkout already adopted by the first admitted run.
  const prepare = () =>
    workspacePreparations.enqueue(`${storePath}\0${sessionKey}`, async () => {
      assertRunOwnership();
      const saved = metadata ? metadata.readCurrent() : loadSessionEntry(target);
      if (
        !saved ||
        saved.sessionId !== entry.sessionId ||
        saved.lifecycleRevision !== entry.lifecycleRevision
      ) {
        throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
      }
      let pending = saved.pendingWorktree;
      const assertSavedWorkspaceIntent = (current: Partial<typeof saved> | undefined) => {
        assertRunOwnership();
        if (
          !current ||
          current.sessionId !== entry.sessionId ||
          current.lifecycleRevision !== entry.lifecycleRevision ||
          current.projectId !== saved.projectId ||
          current.pendingProjectGitUrl !== saved.pendingProjectGitUrl ||
          !isDeepStrictEqual(current.pendingWorktree, pending)
        ) {
          throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
        }
      };
      const gitUrl = normalizeSessionProjectGitUrl(saved.pendingProjectGitUrl);
      if (
        Object.hasOwn(saved, "pendingProjectGitUrl") &&
        (!gitUrl || gitUrl !== saved.pendingProjectGitUrl)
      ) {
        throw new Error("Saved project repository is invalid; select the repository and retry.");
      }
      if (!pending && !gitUrl) {
        Object.assign(entry, saved);
        delete entry.pendingProjectGitUrl;
        delete entry.pendingWorktree;
        return;
      }
      const configuredToken = gitUrl ? githubApiToken(process.env, cfg) : undefined;
      const projectIdentity =
        gitUrl && !configuredToken
          ? await prepareGatewayProjectGitHubIdentity({
              agentId,
              assertActive: assertRunOwnership,
              config: cfg,
              context,
            })
          : undefined;
      const projectToken = configuredToken ?? projectIdentity?.token;
      const assertProjectCurrent = () => {
        assertRunOwnership();
        if (metadata) {
          assertSavedWorkspaceIntent(metadata.readCurrent());
        }
        projectIdentity?.assertSelected();
      };
      const cloneOptions = {
        signal,
        token: projectToken,
        assertCurrent: assertProjectCurrent,
        startRun: projectIdentity?.start,
      };
      const project = gitUrl
        ? await materializeProjectClone({ cfg, gitUrl }, cloneOptions)
        : undefined;
      projectIdentity?.assertSelected();
      assertRunOwnership();
      const directory = project
        ? await resolveProjectDirectory(project.repoRoot)
        : pending?.workspace;
      assertRunOwnership();
      if (!directory) {
        throw new Error("Saved worktree workspace is invalid; select the repository and retry.");
      }
      const root = prepareSessionCreateFilesystemRoot({
        cfg,
        // Direct bindings still require containment. Pending managed checkouts use
        // the saved child requirement and source custody in the preparation owner.
        enforceSandboxContainment: !pending && Boolean(project || saved.projectId),
        requestedProjectId: project?.id ?? saved.projectId,
        sessionCwd: directory,
        sessionKey,
        targetAgentId: agentId,
      });
      if (!root.ok) {
        throw new Error(root.error.message);
      }
      const status = (phase: Parameters<typeof emitAgentRunStatusEvent>[0]["phase"]) => {
        assertRunOwnership();
        emitAgentRunStatusEvent({ runId: clientRunId, sessionKey, agentId, phase });
      };
      const needsTitle = pending && !pending.name && !hasExplicitSessionName(saved);
      if (needsTitle) {
        status("naming_worktree");
      }
      const title =
        pending && !pending.name
          ? await generateWorktreeSessionTitle({
              cfg,
              agentId,
              entry: saved,
              sessionId: saved.sessionId,
              sessionKey,
              storePath,
              userMessage: pending.titleSource,
              commitGuard: assertRunOwnership,
              onPersisted: () =>
                emitSessionsChanged(context, { sessionKey, agentId, reason: "chat.title" }),
              onError: (error) =>
                context.logGateway.warn(`worktree title failed: ${String(error)}`),
            })
          : undefined;
      let prepared: PreparedGatewaySessionLifecycle = {
        spawnedCwd: root.value.sessionCwd,
        sessionRoot: root.value.sessionRoot,
      };
      if (pending) {
        if (pending.baseRef && !pending.baseCommit) {
          let resolved = await resolveSessionWorktreeBase(directory, pending.baseRef, signal);
          if (
            !resolved.ok &&
            resolved.error.code === ErrorCodes.INVALID_REQUEST &&
            project?.source === "cloned"
          ) {
            await refreshProjectClone(project, cloneOptions);
            projectIdentity?.assertSelected();
            assertRunOwnership();
            resolved = await resolveSessionWorktreeBase(directory, pending.baseRef, signal);
          }
          if (!resolved.ok) {
            throw new Error(resolved.error.message);
          }
          // Accept once, before setup can fail: retries keep the commit while the
          // original ref remains publication metadata, never a fallback selection.
          const next = { ...pending, baseCommit: resolved.value };
          const updated = await patchSessionEntryCore(
            target,
            (current) => {
              assertSavedWorkspaceIntent(current);
              return { pendingWorktree: next };
            },
            {
              ...sessionEntryCommitGuardOptions(assertRunOwnership),
              requireWriteSuccess: true,
              skipMaintenance: true,
            },
          );
          if (!updated) {
            throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
          }
          Object.assign(saved, updated);
          pending = next;
        }
        // Retries inherit workspace intent, not a previous caller's setup authority.
        const result = await prepareSessionWorktree({
          cfg,
          target: {
            ...target,
            key: sessionKey,
            entry: saved,
            projectId: project?.id ?? saved.projectId,
            sandboxRequired: saved.sandbox === "required",
          },
          workspace: directory,
          name: pending.name,
          baseRef: pending.baseRef,
          checkoutCommit: pending.baseCommit,
          label: title ?? resolveExplicitSessionName(saved),
          runSetupScript: !cfg.cloudWorkers?.requiredProfile && params.runSetupScript,
          signal,
          commitGuard: assertProjectCurrent,
          onProgress: (stage) => status(stage === "setup" ? "running_setup" : "creating_worktree"),
          acceptedSource: pending.source,
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        prepared = result.value;
      }
      const bound = await commitPreparedSessionWorkspace({
        prepared,
        target,
        projectId: project?.id,
        assertCurrent: assertRunOwnership,
        assertEntry: assertSavedWorkspaceIntent,
        clearPendingIntent: true,
        missingSessionMessage:
          "Session disappeared while preparing its workspace; start a new session.",
      });
      // Once committed the session, not this run, owns the checkout; abort must
      // retain it for retry and must not roll it back after publication.
      Object.assign(entry, bound);
      delete entry.pendingProjectGitUrl;
      delete entry.pendingWorktree;
      assertRunOwnership();
      emitSessionsChanged(context, { sessionKey, agentId, reason: "project" });
    });
  const handled = await withSessionActorStorage(
    target,
    {
      lifetime: { assertCurrent: assertRunOwnership, assertReadable: assertRunOwnership },
      authority: { assertCurrent: assertRunOwnership, authorize() {} },
    },
    async () => {
      await prepare();
      return true;
    },
  );
  if (!handled) {
    await prepare();
  }
  assertRunOwnership();
}
