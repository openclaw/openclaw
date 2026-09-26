// Session creation, initial turns, and managed-worktree provisioning.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { buildDashboardSessionTitleSource } from "../dashboard-session-title.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { startSessionCreateDiagnostics } from "../session-create-diagnostics.js";
import { buildDashboardSessionKey } from "../session-create-key.js";
import { resolveSessionCreateCatalogSelectionError } from "../session-create-model-selection.js";
import { createGatewaySession } from "../session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "../session-create-service.types.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import {
  prepareSessionWorktreeCreation,
  validateSessionWorktreeSelection,
} from "../session-worktree-preparation.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { scheduleCreatedDashboardSessionTitle } from "./chat-send-background.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { idempotentSessionCreate } from "./session-create-idempotency.js";
import {
  resolveSessionCreateInitialTurn,
  isFreshChatSendStarted,
} from "./session-create-initial-turn.js";
import {
  normalizeSessionProjectGitUrl,
  prepareSessionRepositoryWorkspace,
  resolveSessionRepositoryCreation,
  validateSessionProjectPreparation,
  prepareRequiredWorkerWorkspaceInput,
  requiredWorkerWorkspaceReuseError,
} from "./session-create-project.js";
import {
  prepareSessionCreateFilesystemRoot,
  resolveSessionCreateRootParameters,
} from "./session-create-root.js";
import { resolveSessionCreateSpawnContext } from "./session-create-spawn.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  readGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { prepareSessionModelAccountAccess } from "./users-model-account-access.js";
import { assertValidParams } from "./validation.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

export const sessionCreateHandlers: GatewayRequestHandlers = {
  "sessions.create": idempotentSessionCreate(async (options) => {
    using diagnostics = startSessionCreateDiagnostics();
    const {
      params,
      respond,
      context,
      client,
      sessionMutationAuthorization,
      signal,
      hasCurrentClientAuthority,
    } = options;
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = structuredClone(params);
    const requiredProfile = context.getRuntimeConfig().cloudWorkers?.requiredProfile;
    try {
      assertRequiredWorkerSelection(context.getRuntimeConfig(), p);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
    const automaticEmptyWorkspace = prepareRequiredWorkerWorkspaceInput(p, requiredProfile);
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const getCurrentConfig = context.getRuntimeConfig;
    const requestingOperatorProfileId = client?.authenticatedUserProfile?.profileId;
    const operatorRoleActor = client?.internal?.operatorRoleActor
      ? { ...client.internal.operatorRoleActor }
      : undefined;
    const emptyWorkspace = p.worktreeSource === "empty";
    const worktreeSelectionError = validateSessionWorktreeSelection(p);
    if (worktreeSelectionError) {
      respond(false, undefined, worktreeSelectionError);
      return;
    }
    const parentSessionKey = normalizeOptionalString(p.parentSessionKey);
    const sessionCreation = prepareSkillLibrarySessionCreation(
      client,
      context.getRuntimeConfig,
      resolveOperatorSessionCreation(client, { allowTrustedHint: true }),
    );
    const spawnRequesterSessionKey =
      sessionCreation.via === "spawn"
        ? normalizeOptionalString(sessionCreation.requesterSessionKey)
        : undefined;
    if (sessionCreation.inheritedToolPolicy && parentSessionKey !== spawnRequesterSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "spawn parent must match the trusted agent caller"),
      );
      return;
    }
    const requestedModel = normalizeOptionalString(p.model);
    let personalAccounts: Awaited<ReturnType<typeof prepareSessionModelAccountAccess>>;
    try {
      personalAccounts = await prepareSessionModelAccountAccess(options, requestedModel);
    } catch (error) {
      if (!(error instanceof ModelAccountConnectAuthorityError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
      return;
    }
    const { personalModelSelection, personalAccountDefaults } = personalAccounts;
    const cfg = getCurrentConfig();
    const authority = createAgentRuntimeAuthorityGuard(client, context, respond);
    // Both uncommitted selections must remain authorized after awaited preparation.
    const commitGuard = () => {
      requestAuthority.assertCurrent();
      if (getCurrentConfig().cloudWorkers?.requiredProfile !== requiredProfile) {
        throw new Error("Required worker policy changed during session creation; retry.");
      }
      assertRequiredWorkerSelection(getCurrentConfig(), p);
      authority.commitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      assertPreparedSkillLibrarySelection(sessionCreation.skillLibrarySelections);
      personalModelSelection?.assertCurrent();
      personalAccountDefaults?.assertCurrent();
    };
    await using operatorCapture = {
      preparation: captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority,
        invocationAuthority: { assertCurrent: commitGuard, signal },
      }),
      async [Symbol.asyncDispose]() {
        const captured = await this.preparation.catch(() => undefined);
        captured?.release();
      },
    };
    void operatorCapture.preparation.catch(() => {});
    const catalogId = normalizeOptionalString(p.catalogId);
    const catalogError = resolveSessionCreateCatalogSelectionError(p);
    if (catalogError) {
      respond(false, undefined, catalogError);
      return;
    }
    const explicitlyRequestedKey = normalizeOptionalString(p.key);
    const explicitlyRequestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      explicitlyRequestedKey ?? (p.agentId === undefined ? "main" : undefined),
      p.agentId ?? parseAgentSessionKey(explicitlyRequestedKey)?.agentId,
    );
    if (!explicitlyRequestedAgent.ok) {
      respond(false, undefined, explicitlyRequestedAgent.error);
      return;
    }
    const catalogRequestedKey = normalizeOptionalString(p.key) ?? "global";
    const catalogAgentId = catalogId
      ? normalizeAgentId(
          parseAgentSessionKey(catalogRequestedKey)?.agentId ?? explicitlyRequestedAgent.agentId,
        )
      : undefined;
    const catalogTarget =
      catalogId && catalogAgentId
        ? resolveRegisteredCatalogCreateTarget(catalogId, catalogAgentId, cfg)
        : undefined;
    if (catalogTarget && !catalogTarget.ok) {
      respond(
        false,
        undefined,
        errorShape(
          catalogTarget.unknownCatalog ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          catalogTarget.message,
        ),
      );
      return;
    }
    const initialTurn = resolveSessionCreateInitialTurn(p);
    if (!initialTurn) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.create attachments require usable content",
        ),
      );
      return;
    }
    const { attachments, hasInitialTurn, message } = initialTurn;
    const repositoryCreation = resolveSessionRepositoryCreation(p, hasInitialTurn);
    if (!repositoryCreation.ok) {
      respond(false, undefined, repositoryCreation.error);
      return;
    }
    const repository = repositoryCreation.value;
    let sessionKey = explicitlyRequestedKey;
    const initialRunId = randomUUID();
    if (p.mentions?.length) {
      if (catalogId || p.incognito) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Human mentions are unavailable for this session mode. Remove the selected mentions to continue.",
          ),
        );
        return;
      }
      // Mention validation and later creation must use the same real child target.
      sessionKey ??= buildDashboardSessionKey(explicitlyRequestedAgent.agentId);
      const normalized = normalizeChatSendRequest({
        params: {
          sessionKey,
          message: message ?? "",
          mentions: p.mentions,
          idempotencyKey: initialRunId,
        },
        client,
      });
      if (!normalized.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, normalized.error));
        return;
      }
      const eligible = context.mentionInbox?.validateRecipients(
        client,
        {
          agentId: explicitlyRequestedAgent.agentId,
          ...(p.visibility ? { visibility: p.visibility } : {}),
        },
        p.mentions.map((mention) => mention.profileId),
      );
      if (!eligible?.ok) {
        respond(
          false,
          undefined,
          eligible?.error ??
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "Human mentions are unavailable; reconnect and retry.",
            ),
        );
        return;
      }
    }
    let requestedCwd = normalizeOptionalString(p.cwd);
    const requestedExecNode = normalizeOptionalString(p.execNode);
    const requestedProjectId = normalizeOptionalString(p.projectId);
    const requestedProjectGitUrl = p.projectGitUrl;
    const projectPreparationError = validateSessionProjectPreparation({
      cwd: requestedCwd,
      execNode: requestedExecNode,
      gitUrl: requestedProjectGitUrl,
      hasInitialTurn,
      projectId: requestedProjectId,
    });
    if (projectPreparationError) {
      respond(false, undefined, projectPreparationError);
      return;
    }
    // Agent tools expand `~` before RPC; the Gateway contract stays absolute-only.
    // Remote nodes may use Windows paths; local cwd must match the Gateway host.
    const cwdIsAbsolute =
      !requestedCwd ||
      (requestedExecNode
        ? path.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd)
        : path.isAbsolute(requestedCwd));
    if (!cwdIsAbsolute) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd must be absolute"),
      );
      return;
    }
    const clientScopes = Array.isArray(client?.connect?.scopes) ? [...client.connect.scopes] : [];
    if (p.permissionMode === "full" && client !== null && !clientScopes.includes(ADMIN_SCOPE)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    if (requestedCwd && !requestedExecNode && !clientScopes.includes(ADMIN_SCOPE)) {
      const containment = await resolveWorkspacePathContainment(requestedCwd, cfg);
      if (!containment) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope: ADMIN_SCOPE,
            requiredScopes: [ADMIN_SCOPE],
          }),
        );
        return;
      }
      requestedCwd = containment.path;
    }
    const worktreeBaseRef = normalizeOptionalString(p.worktreeBaseRef);
    const requestedWorktreeName = normalizeOptionalString(p.worktreeName);
    const explicitSessionLabel = normalizeOptionalString(p.label);
    const preparedDisplayName = normalizeOptionalString(p.displayName);
    const titleAgentId = explicitlyRequestedAgent.agentId;
    const existingTargetEntry = explicitlyRequestedKey
      ? loadGatewaySessionEntryReadOnly(explicitlyRequestedKey, { agentId: titleAgentId }).entry
      : undefined;
    const workspaceReuseError = requiredWorkerWorkspaceReuseError(
      automaticEmptyWorkspace,
      existingTargetEntry,
    );
    if (workspaceReuseError) {
      respond(false, undefined, workspaceReuseError);
      return;
    }
    if (existingTargetEntry?.repositoryWorkspaceId && !repository) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Repository sessions require their original repository source; dispatch the existing session to continue.",
        ),
      );
      return;
    }
    const deferWorktree =
      p.worktree === true && !emptyWorkspace && hasInitialTurn && !existingTargetEntry;
    let projectRoot: string | undefined;
    if (requestedProjectId) {
      const project = await resolveProjectRegistry(cfg, requestedProjectId);
      if (!project) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${requestedProjectId}`),
        );
        return;
      }
      try {
        const checkout =
          p.worktree === true ? await resolveProjectCheckout(project.repoRoot) : undefined;
        projectRoot = checkout?.path ?? (await resolveProjectDirectory(project.repoRoot));
        if (checkout && project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
          throw new ProjectCheckoutError(`project root is no longer a git checkout`);
        }
      } catch (error) {
        const detail =
          error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `project ${requestedProjectId} is unavailable (${detail}); update the agent workspace path or re-register the project`,
          ),
        );
        return;
      }
    }
    let sessionAgentId = catalogAgentId ?? explicitlyRequestedAgent.agentId;
    if (repository) {
      sessionKey ??= buildDashboardSessionKey(sessionAgentId);
    }
    let preparedWorktree: PreparedGatewaySessionLifecycle | undefined;
    const sessionExecCwd = requestedExecNode ? requestedCwd : undefined;
    let sessionCwd = requestedExecNode ? undefined : (projectRoot ?? requestedCwd);
    let prepareLifecycle: Parameters<typeof createGatewaySession>[0]["prepareLifecycle"];
    const preparedRoot =
      repository || emptyWorkspace
        ? undefined
        : prepareSessionCreateFilesystemRoot({
            cfg,
            enforceSandboxContainment: Boolean(
              sessionCwd && !requestedExecNode && p.worktree !== true,
            ),
            requestedExecNode,
            requestedProjectId,
            sessionCwd,
            sessionKey,
            targetAgentId: sessionAgentId,
          });
    if (preparedRoot && !preparedRoot.ok) {
      respond(false, undefined, preparedRoot.error);
      return;
    }
    sessionCwd = preparedRoot?.value.sessionCwd;
    if (repository) {
      prepareLifecycle = prepareSessionRepositoryWorkspace(repository, {
        runSetupScript: clientScopes.includes(ADMIN_SCOPE),
        assertCurrent: commitGuard,
      });
    }
    if (p.worktree === true) {
      // Raw cwd authorization and project-registry selection have already been checked.
      const agentId = explicitlyRequestedAgent.agentId;
      let targetKey = sessionKey;
      let preservesUnspecifiedKey = false;
      if (
        !targetKey &&
        parentSessionKey &&
        p.emitCommandHooks === true &&
        !hasInitialTurn &&
        cfg.session?.dmScope === "main"
      ) {
        const parentRequestedAgent = resolveRequestedGlobalAgentId(cfg, parentSessionKey, agentId);
        if (!parentRequestedAgent.ok) {
          respond(false, undefined, parentRequestedAgent.error);
          return;
        }
        const parent = loadGatewaySessionEntryReadOnly(parentSessionKey, {
          agentId: parentRequestedAgent.agentId,
        });
        const parentAgentId = parentRequestedAgent.agentId;
        if (
          parent.entry?.sessionId &&
          parent.canonicalKey === resolveAgentMainSessionKey({ cfg, agentId: parentAgentId })
        ) {
          targetKey = parent.canonicalKey;
          preservesUnspecifiedKey = true;
        }
      }
      targetKey ??= buildDashboardSessionKey(agentId);
      const target = resolveGatewaySessionStoreTarget({ cfg, key: targetKey, agentId });
      sessionKey = preservesUnspecifiedKey ? undefined : targetKey;
      sessionAgentId = target.agentId;
      const inheritParentWorktree =
        !emptyWorkspace &&
        !projectRoot &&
        !requestedCwd &&
        !requestedProjectGitUrl &&
        spawnRequesterSessionKey &&
        spawnRequesterSessionKey === parentSessionKey &&
        sessionCreation.actor?.type === "agent" &&
        normalizeAgentId(sessionCreation.actor.id) === target.agentId;
      prepareLifecycle = async (lifecycleTarget) => {
        const prepared = await prepareSessionWorktreeCreation({
          cfg,
          target: lifecycleTarget,
          workspace: emptyWorkspace ? { kind: "empty" } : (projectRoot ?? requestedCwd),
          inheritParentKey: inheritParentWorktree ? spawnRequesterSessionKey : undefined,
          projectGitUrl: requestedProjectGitUrl,
          name: requestedWorktreeName,
          baseRef: worktreeBaseRef,
          deferWorktree,
          label: explicitSessionLabel ?? preparedDisplayName,
          titleSource: buildDashboardSessionTitleSource({ message: message ?? "", attachments }),
          currentUserMessage: message,
          useRequestedTitleSelection: Boolean(requestedModel && !personalModelSelection),
          runSetupScript: !requiredProfile && clientScopes.includes(ADMIN_SCOPE),
          signal,
          commitGuard,
          onTitleError: (error) =>
            sessionLog.warn(`worktree title failed: ${formatErrorMessage(error)}`),
          onTitlePersisted: () =>
            emitSessionsChanged(context, {
              sessionKey: lifecycleTarget.key,
              agentId: lifecycleTarget.agentId,
              reason: "chat.title",
            }),
        });
        if (prepared.ok) {
          preparedWorktree = prepared.value;
        }
        return prepared;
      };
    }
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const allowExistingModelSelection = authorizeOperatorScopesForRequiredScope(
      ADMIN_SCOPE,
      clientScopes,
    ).allowed;
    if (!authority.ensureActive()) {
      return;
    }
    const createParams: Parameters<typeof createGatewaySession>[0] = {
      cfg,
      getCurrentConfig,
      onPhase: diagnostics?.mark,
      operatorAuthority: operatorCapture.preparation,
      key: sessionKey,
      agentId: sessionAgentId,
      label: p.label,
      displayName: preparedDisplayName,
      category: p.category,
      ...(catalogTarget
        ? { catalogTarget: catalogTarget.target }
        : { model: requestedModel, agentRuntime: p.agentRuntime }),
      personalModelSelection,
      personalAccountDefaults,
      contextWindow: p.contextWindow,
      thinkingLevel: p.thinkingLevel,
      fastMode: p.fastMode,
      projectId: requestedProjectId,
      pendingProjectGitUrl: normalizeSessionProjectGitUrl(requestedProjectGitUrl),
      incognito: p.incognito,
      ...(client?.connect ? { requestingOperatorScopes: clientScopes } : {}),
      ...(requestingOperatorProfileId ? { requestingOperatorProfileId } : {}),
      ...(operatorRoleActor ? { operatorRoleActor } : {}),
      visibility: p.visibility,
      allowExistingModelSelection,
      parentSessionKey,
      spawnDepth: p.spawnDepth,
      ...resolveSessionCreateRootParameters(p, preparedRoot?.value),
      permissionMode: p.permissionMode,
      ...(p.toolOverrides !== undefined ? { toolOverrides: p.toolOverrides } : {}),
      prepareLifecycle,
      onLifecycleCleanupError: (error) =>
        sessionLog.warn(
          `failed to finalize session worktree lifecycle: ${formatErrorMessage(error)}`,
        ),
      execNode: requestedExecNode,
      execCwd: sessionExecCwd,
      clearExecBinding: !requestedExecNode,
      // A plain New Chat with no cwd must not inherit the prior session cwd.
      clearSpawnedCwd: p.worktree !== true && !sessionCwd,
      fork: p.fork,
      forkFrom: p.forkFrom,
      ...resolveSessionCreateSpawnContext({
        client,
        creation: sessionCreation,
        agentId: sessionAgentId,
        model: requestedModel,
        parentSessionKey,
        fork: p.fork,
        forkFrom: p.forkFrom,
        emitCommandHooks: p.emitCommandHooks,
        assertRuntimeCurrent: authority.commitGuard,
      }),
      succeedsParent: p.succeedsParent,
      emitCommandHooks: p.emitCommandHooks,
      resetMainWhenUnspecified: !hasInitialTurn,
      commandSource: "webchat",
      creation: sessionCreation,
      authorizedPluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
      armSessionDiffBaselineCapture: !repository,
      loadGatewayModelCatalogSnapshot: () =>
        context.loadGatewayModelCatalogSnapshot({ agentId: sessionAgentId }),
      commitGuard,
      afterSessionCommitted: (entry, source) =>
        registerCommittedSessionCategory(
          entry.category === normalizeOptionalString(p.category) ? entry.category : undefined,
          context,
          source,
        ),
      onCreatedSessionCommitted: (committed) => {
        sessionMutationAuthorization?.recordCreatedSession?.({
          agentId: committed.agentId,
          sessionKey: committed.key,
          storePath: committed.storePath,
          sessionId: committed.entry.sessionId,
          lifecycleRevision: committed.entry.lifecycleRevision,
        });
      },
      afterCreate: async (session) => {
        if (!authority.hasActive()) {
          return;
        }
        if (requiredProfile && !preparedWorktree?.pendingWorktree && !requestedProjectGitUrl) {
          const prepare = context.workerPlacementDispatchService?.prepareRequiredSession;
          if (!prepare) {
            throw new Error(
              "Required worker placement is unavailable; repair the configured profile and retry.",
            );
          }
          await prepare(
            {
              sessionId: session.entry.sessionId,
              sessionKey: session.key,
              agentId: session.agentId,
            },
            commitGuard,
            signal,
            { waitForReady: false },
          );
          commitGuard();
        }
        if (!hasInitialTurn) {
          scheduleCreatedDashboardSessionTitle(session, cfg, context, p.titleSource);
          return;
        }
        const sendOptions = bindGatewayRequestHandlerMutationAuthority(
          options,
          {
            ...options,
            params: {
              sessionKey: session.key,
              agentId: session.agentId,
              message: message ?? "",
              idempotencyKey: initialRunId,
              ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
              ...(p.mentions ? { mentions: p.mentions } : {}),
              ...(attachments ? { attachments } : {}),
            },
            respond: (ok, payload, error, meta) => {
              if (ok && payload && typeof payload === "object") {
                runPayload = payload as Record<string, unknown>;
              } else {
                runError = error;
              }
              runMeta = meta;
            },
          },
          undefined,
        );
        await handleDirectExternalChatSend(sendOptions);
      },
    };
    const created = await createGatewaySession(createParams).catch((error: unknown) => {
      if (error instanceof ModelAccountConnectAuthorityError) {
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
        return undefined;
      }
      return authority.handleClosedError(error);
    });
    if (!created) {
      return;
    }
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    if (created.postCommit.status === "failed") {
      runError = errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(created.postCommit.error));
    }
    const createdWorktree = preparedWorktree?.worktree
      ? {
          id: preparedWorktree.worktree.id,
          path: preparedWorktree.sessionRoot,
          branch: preparedWorktree.worktree.branch,
        }
      : undefined;
    const responseEntry = sessionEntryForkedFromParent(created.entry)
      ? { ...created.entry, forkedFromParent: true as const }
      : created.entry;
    const runStarted =
      !created.resetExisting &&
      isFreshChatSendStarted({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    diagnostics?.mark("response");
    respond(true, {
      ok: true,
      key: created.key,
      sessionId: created.entry.sessionId,
      entry: responseEntry,
      runStarted,
      ...(!created.resetExisting && runPayload ? runPayload : {}),
      ...(!created.resetExisting && runError ? { runError } : {}),
      resolved: created.resolved,
      ...(createdWorktree ? { worktree: createdWorktree } : {}),
    });
    diagnostics?.mark("handlerExit");
    emitSessionsChanged(context, {
      sessionKey: created.key,
      agentId: created.agentId,
      reason: created.resetExisting ? "new" : "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: created.key,
        agentId: created.agentId,
        reason: "send",
      });
    }
  }),
};
