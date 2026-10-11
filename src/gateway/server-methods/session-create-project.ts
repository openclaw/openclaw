import { isDeepStrictEqual } from "node:util";
import { ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { emitAgentRunStatusEvent } from "../../infra/agent-run-status-events.js";
import { toErrorObject } from "../../infra/errors.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { materializeProjectClone, refreshProjectClone } from "../../projects/project-clone.js";
import { parseConfiguredProjectGitUrl } from "../../projects/project-git-url.runtime.js";
import { resolveProjectDirectory } from "../../projects/project-registry.js";
import { ensureSessionDiffBaseline } from "../../sessions/session-diff-baseline.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { githubApiToken } from "../github-public-api.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { prepareGatewayProjectGitHubIdentity } from "../project-github-identity.js";
import type {
  PrepareGatewaySessionLifecycle,
  PreparedGatewaySessionLifecycle,
} from "../session-create-service.types.js";
import { commitPreparedSessionWorkspace } from "../session-lifecycle-preparation.js";
import { invalidSessionRequest } from "../session-request-error.js";
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
  const promptReady = createDeferredCore();
  let preparationFailure: Error | undefined;
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
        controller.abort(preparationFailure);
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
    Pick<GatewayRequestHandlerOptions["context"], "logGateway">;
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
  const incognito = captureIncognitoSessionSource(target);
  const metadata = captureSessionEntryMetadataRead(target);
  const claim =
    incognito && !("kind" in incognito)
      ? incognito.actor.sessions.captureCurrent(sessionKey)
      : undefined;
  const assertRunOwnership = composeSessionSourceAssertion(
    [params.assertCurrent],
    (assertSources) => {
      signal.throwIfAborted();
      assertSources();
      metadata?.assertCurrent();
      claim?.assertCurrent();
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
      const saved = incognito
        ? await (
            await import("../../config/sessions/session-entry-read-runtime.js")
          ).readSessionEntryReadOnlyInWorker(target, assertRunOwnership)
        : loadSessionEntry(target);
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
          // An existing title can name the checkout; otherwise allocation owns
          // its short generated name while the chat title is prepared separately.
          label: resolveExplicitSessionName(saved),
          runSetupScript: !cfg.cloudWorkers?.requiredProfile && params.runSetupScript,
          signal,
          commitGuard: assertProjectCurrent,
          onProgress: (stage) => status(stage === "setup" ? "running_setup" : "creating_worktree"),
          acceptedSource: pending.source,
          onPromptReady: params.onPromptReady
            ? async (promptWorkspace) => {
                // Keep pending intent authoritative until the complete checkout
                // is published. These path facts let only this admitted turn
                // initialize its prompt in the final execution directory.
                const bound = await commitPreparedSessionWorkspace({
                  prepared: promptWorkspace,
                  target,
                  projectId: project?.id,
                  assertCurrent: assertRunOwnership,
                  assertEntry: assertSavedWorkspaceIntent,
                  missingSessionMessage:
                    "Session disappeared while preparing its workspace; start a new session.",
                });
                // Subsequent Git effects must accept the project binding this
                // preparation just published, while retaining its pending intent.
                Object.assign(saved, bound);
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
  await (incognito && !("kind" in incognito)
    ? incognito.actor.sessions.withSharedState(prepare)
    : prepare());
  assertRunOwnership();
}
