import { isDeepStrictEqual } from "node:util";
import { ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolvePreparedWorktreeBase } from "../../agents/worktrees/base-ref.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withSessionActorStorage } from "../../config/sessions/session-actor-storage-acquisition.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
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
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizePluginRepositoryUrl as normalizeSessionProjectGitUrl } from "../../plugins/repository-source-url.js";
import { withProjectCheckoutLifecycle } from "../../projects/project-checkout.js";
import {
  resolveProjectDirectory,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceProjectSessionActive,
  isRpcSourceRegistered,
  requestRpcSourceCancellation,
} from "../../sessions/session-controller.rpc-sources.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { RepositorySources } from "../repository-sources.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "../session-create-service.types.js";
import { commitPreparedSessionWorkspace } from "../session-lifecycle-preparation.js";
import { invalidSessionRequest, unavailableSessionRequest } from "../session-request-error.js";
import { resolveExplicitSessionName } from "../session-title-state.js";
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

export function resolveSessionCreateRepositorySource(
  params: SessionsCreateParams,
  sources: RepositorySources | undefined,
): Result<ReturnType<RepositorySources["resolve"]> | undefined, ErrorShape> {
  const url = params.repository?.url ?? params.projectGitUrl;
  if ((url && !normalizeSessionProjectGitUrl(url)) || (params.repositorySource && !url)) {
    return invalidSessionRequest("Select a supported repository URL with its repository source.");
  }
  if (!url && !params.repositorySource) {
    return ok(undefined);
  }
  try {
    if (!url || !sources) {
      throw new Error(
        "Repository sources are unavailable. Enable the source plugin or choose a local folder.",
      );
    }
    const source = sources.resolve(url, params.repositorySource);
    if (params.repository) {
      params.repository.url = source.url;
    }
    if (params.projectGitUrl) {
      params.projectGitUrl = source.url;
    }
    return ok(source);
  } catch (error) {
    return unavailableSessionRequest(formatErrorMessage(error));
  }
}

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
      "Use a supported repository URL and a nonempty branch, tag, or commit ref.",
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
  options: { runSetupScript: boolean; branchPrefix?: string; assertCurrent: () => void },
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
      branchPrefix: options.branchPrefix,
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

export function validateSessionWorktreeSelection(
  params: SessionsCreateParams,
): ErrorShape | undefined {
  if (
    params.worktreeSource === "empty" &&
    (params.worktree !== true ||
      params.cwd ||
      params.projectId ||
      params.projectGitUrl ||
      params.repository ||
      params.catalogId ||
      params.execNode ||
      params.worktreeBaseRef)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeSource=empty requires worktree=true and cannot include another workspace source, catalog, execNode, or worktreeBaseRef",
    );
  }
  if (normalizeOptionalString(params.execNode) && params.worktree === true) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktree cannot target execNode",
    );
  }
  if (
    (normalizeOptionalString(params.worktreeBaseRef) ||
      normalizeOptionalString(params.worktreeName)) &&
    params.worktree !== true
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "sessions.create worktreeBaseRef/worktreeName require worktree=true",
    );
  }
  return undefined;
}

export { normalizePluginRepositoryUrl as normalizeSessionProjectGitUrl } from "../../plugins/repository-source-url.js";

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
      "Use a supported HTTPS or SSH repository URL. Local paths and file URLs are not accepted.",
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
export function prepareSessionWorkspace(params: {
  admission: AdmittedChatSend;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  session: PreparedChatSendSession;
}) {
  const { admission, client, context, session } = params;
  const { entry, clientRunId, sessionKey } = session;
  if (!entry) {
    throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
  }
  const signal = admission.activeRunAbort.entry.input.abortSignal;
  const assertRunOwnership = () => {
    signal.throwIfAborted();
    const activeRun = admission.activeRunAbort.entry;
    const activeRunIdentity = getRpcSourceIdentity(activeRun);
    if (
      !isRpcSourceRegistered(activeRun) ||
      activeRun.input.abortSignal !== signal ||
      activeRunIdentity.sessionKey !== sessionKey ||
      activeRunIdentity.sessionId !== entry.sessionId ||
      entry.sessionId !== admission.admittedSessionId ||
      getRpcSourceLifecycleGeneration(activeRun) !== admission.lifecycleGeneration ||
      getRpcSourceProjectSessionActive(activeRun) === false ||
      activeRun.adapter.projectSessionTerminalPending === true ||
      activeRun.adapter.projectSessionTerminalPersisted === true ||
      !hasActiveAgentRuntimeAuthority(client, context)
    ) {
      throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
    }
    assertAgentRunLifecycleGenerationCurrent(admission.lifecycleGeneration);
  };
  const promptReady = createDeferredCore();
  let preparationFailure: Error | undefined;
  let workspaceReady = false;
  const preparation = prepareSessionWorkspaceForRun({
    ...session,
    entry,
    runId: clientRunId,
    context,
    signal,
    assertCurrent: assertRunOwnership,
    runSetupScript: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
    // Worker placement transfers a complete checkout before admitting inference.
    onPromptReady: session.cfg.cloudWorkers?.requiredProfile
      ? undefined
      : () => promptReady.resolve(),
  });
  const ready = preparation
    .then(async () => {
      assertRunOwnership();
      // Attribution still precedes the first workspace effect, but no longer
      // precedes inference for a newly allocated checkout.
      await ensureSessionDiffBaseline({
        agentId: session.agentId,
        cwd: entry.spawnedCwd!,
        entry,
        isNewSession: false,
        sessionKey,
        storePath: session.storePath,
      });
      assertRunOwnership();
      workspaceReady = true;
      promptReady.resolve();
    })
    .catch((error: unknown) => {
      // One failed preparation cancels the admitted turn. Concurrent tool calls
      // observe that same failure rather than each starting a new preparation.
      if (!signal.aborted) {
        // Preserve typed causes and actionable text in the bounded error displays.
        preparationFailure = toErrorObject(
          error,
          "Workspace preparation failed; check the repository and retry.",
        );
        requestRpcSourceCancellation(admission.activeRunAbort.entry, preparationFailure);
      }
      const failure = preparationFailure ?? error;
      promptReady.reject(failure);
      throw failure;
    });
  void ready.catch(() => {});
  void promptReady.promise.catch(() => {});
  return {
    sessionKey,
    assertCurrent: assertRunOwnership,
    promptReady: promptReady.promise,
    isReady: () => workspaceReady,
    waitUntilReady: () => ready,
    getFailure: () => preparationFailure,
  };
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
    Pick<GatewayRequestHandlerOptions["context"], "logGateway" | "repositorySources">;
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  runSetupScript: boolean;
  onPromptReady?: () => void;
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
      const initial = metadata
        ? metadata.readCurrent()
        : await readSessionEntryReadOnlyInWorker(target, assertRunOwnership);
      if (
        !initial ||
        initial.sessionId !== entry.sessionId ||
        initial.lifecycleRevision !== entry.lifecycleRevision
      ) {
        throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
      }
      let saved = initial;
      let pending = saved.pendingWorktree;
      const assertSavedWorkspaceIntent = (current: Partial<typeof saved> | undefined) => {
        assertRunOwnership();
        if (
          !current ||
          current.sessionId !== entry.sessionId ||
          current.lifecycleRevision !== entry.lifecycleRevision ||
          current.projectId !== saved.projectId ||
          current.pendingProjectGitUrl !== saved.pendingProjectGitUrl ||
          current.repositorySourceId !== saved.repositorySourceId ||
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
      const assertSavedProjectCurrent = () => {
        assertRunOwnership();
        if (metadata) {
          assertSavedWorkspaceIntent(metadata.readCurrent());
        }
      };
      const source = gitUrl
        ? context.repositorySources?.resolve(gitUrl, saved.repositorySourceId)
        : undefined;
      if (gitUrl && !source) {
        throw new Error("The repository source is unavailable. Enable its plugin and retry.");
      }
      const preparedProject = await source?.prepare({
        agentId,
        signal,
        assertCurrent: assertSavedProjectCurrent,
      });
      const assertProjectCurrent = () => {
        assertSavedProjectCurrent();
        preparedProject?.assertCurrent();
      };
      const project = preparedProject?.project;
      assertProjectCurrent();
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
        sandboxRequired: saved.sandbox === "required",
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
      let prepared: PreparedGatewaySessionLifecycle = {
        spawnedCwd: root.value.sessionCwd,
        sessionRoot: root.value.sessionRoot,
      };
      if (pending) {
        if (!pending.baseCommit && (pending.baseRef || preparedProject)) {
          let selectedRef = pending.baseRef;
          let resolved = selectedRef
            ? await resolveSessionWorktreeBase(directory, selectedRef, signal, assertProjectCurrent)
            : undefined;
          if (
            !resolved ||
            (!resolved.ok &&
              resolved.error.code === ErrorCodes.INVALID_REQUEST &&
              project?.source === "cloned")
          ) {
            if (preparedProject) {
              const base = await preparedProject.resolveBase(selectedRef);
              assertProjectCurrent();
              const commit = selectedRef
                ? await resolveSessionWorktreeBase(
                    directory,
                    base.commit,
                    signal,
                    assertProjectCurrent,
                  )
                : ok<string, ErrorShape>(
                    await withProjectCheckoutLifecycle(directory, { signal }, async (lease) => {
                      const assertCurrent = () => {
                        lease.assertOwned();
                        assertProjectCurrent();
                      };
                      const current = await resolveProjectRegistry(cfg, preparedProject.project.id);
                      const currentRoot =
                        current?.source === "workspace"
                          ? await resolveProjectDirectory(current.repoRoot)
                          : current?.repoRoot;
                      assertCurrent();
                      if (
                        !current ||
                        currentRoot !== directory ||
                        current.source !== preparedProject.project.source
                      ) {
                        throw new Error(SESSION_PROJECT_OWNERSHIP_ERROR);
                      }
                      return await resolvePreparedWorktreeBase(
                        directory,
                        base,
                        lease.signal,
                        assertCurrent,
                      );
                    }),
                  );
              selectedRef ??= base.ref;
              resolved = commit;
            }
          }
          assertProjectCurrent();
          if (!resolved?.ok) {
            throw new Error(
              resolved?.error.message ?? "Repository base is unavailable; reselect the repository.",
            );
          }
          // Accept once, before setup can fail: retries keep the commit while the
          // original ref remains publication metadata, never a fallback selection.
          const next = { ...pending, baseRef: selectedRef, baseCommit: resolved.value };
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
          saved = { ...saved, ...updated };
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
          // An existing title can name the checkout; otherwise allocation owns
          // its short generated name while the chat title is prepared separately.
          label: resolveExplicitSessionName(saved),
          runSetupScript: !cfg.cloudWorkers?.requiredProfile && params.runSetupScript,
          signal,
          commitGuard: assertProjectCurrent,
          onProgress: (stage) =>
            status(
              stage === "base"
                ? "preparing_worktree_base"
                : stage === "setup"
                  ? "running_setup"
                  : "creating_worktree",
            ),
          acceptedSource: pending.source,
          onPromptReady: params.onPromptReady
            ? async (promptWorkspace) => {
                // Keep pending intent authoritative until the complete checkout
                // is published. These path facts let only this admitted turn
                // initialize its prompt in the final execution directory.
                const bound = await commitPreparedSessionWorkspace({
                  prepared: promptWorkspace,
                  signal,
                  target,
                  projectId: project?.id,
                  assertCurrent: assertRunOwnership,
                  assertEntry: assertSavedWorkspaceIntent,
                  missingSessionMessage:
                    "Session disappeared while preparing its workspace; start a new session.",
                });
                // Subsequent Git effects must accept the project binding this
                // preparation just published, while retaining its pending intent.
                saved = { ...saved, ...bound };
                Object.assign(entry, bound);
                params.onPromptReady?.();
              }
            : undefined,
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        prepared = result.value;
      }
      const bound = await commitPreparedSessionWorkspace({
        prepared,
        signal,
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
