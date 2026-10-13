import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSharedStoreOwnerError } from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import { resolveAgentWorkspaceDir, tryResolveSoleAgentId } from "../../agents/agent-scope.js";
import {
  createAgentIdentityConfig,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import {
  AgentDeletionTargetsPendingError,
  assertAgentDeletionTargetsUnchanged,
} from "../../config/agent-workspace-roster-transition.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import { readAgentDeletionJournalAsync } from "../../state/agent-deletion-journal.js";
import { resolveUserPath } from "../../utils.js";
import { reviveAgentDatabasesAfterConfigCommit } from "../server-reload-agent-databases.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import {
  AgentConfigPreconditionError,
  AgentModelSelectionError,
  createAgentConfigEntry,
  isConfiguredAgent,
  isImplicitAgentModelUpdate,
  updateAgentConfigEntry,
  validateAgentModelSelectionUpdate,
} from "./agents-config-mutations.js";
import {
  AgentSharedAuthStoreOwnerError,
  agentOwnsSharedAuthStore,
  deleteGatewayAgent,
} from "./agents-delete.js";
import {
  agentFileHandlers,
  buildIdentityMarkdownOrRespondUnsafe,
  writeWorkspaceFileOrRespond,
} from "./agents-files.js";
import { agentListHandler } from "./agents-list.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondAgentNotFound(respond: RespondFn, agentId: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" not found`));
}

function createAgentConfigApplication(respond: RespondFn) {
  const application = createRuntimeConfigWriteApplication(
    captureGatewayRootWorkAdmissionContinuationScope()?.run,
  );
  return {
    attach: <T extends object>(options: T) =>
      attachRuntimeConfigWriteApplication(options, application),
    confirm: async () => {
      const outcome = application.claimed ? await application.result : "unclaimed";
      if (outcome === "applied") {
        return true;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Agent configuration was saved but its application to the active Gateway was not confirmed (${outcome}); run config.get, then apply the saved config or restart the Gateway.`,
        ),
      );
      return false;
    },
  };
}

export const agentsHandlers: GatewayRequestHandlers = {
  "agents.list": agentListHandler,
  "agents.create": async (options) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateAgentsCreateParams, "agents.create", respond)) {
      return;
    }

    let assertOwnerCurrent: (() => void) | undefined;
    try {
      assertOwnerCurrent = params.expectedOwnerId
        ? captureLocalStateMutationGuard(params.expectedOwnerId, options)
        : undefined;
    } catch (error) {
      respond(false, undefined, localStateOwnerChangedError(error));
      return;
    }
    const application = createAgentConfigApplication(respond);
    try {
      const result = await createAgentConfigEntry(
        {
          name: params.name,
          workspace: params.workspace,
          model: params.model,
          emoji: params.emoji,
          avatar: params.avatar,
          beforePersistentApply: assertOwnerCurrent,
          assertIdentityInputAllowed: captureGatewayClientUploadCommitGuard({
            method: "agents.create",
            requestParams: params,
            client,
            context,
          }),
        },
        application.attach({}),
      );
      if (result.status === "error") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.message));
        return;
      }
      await reviveAgentDatabasesAfterConfigCommit([result.agentId], (message) =>
        context.logGateway.warn(message),
      );
      if (!(await application.confirm())) {
        return;
      }
      respond(
        true,
        {
          ok: true,
          agentId: result.agentId,
          name: result.name,
          workspace: result.workspace,
          agentDir: result.agentDir,
          ...(result.model ? { model: result.model } : {}),
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    }
  },
  "agents.update": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateAgentsUpdateParams, "agents.update", respond)) {
      return;
    }

    const assertUploadCurrent = captureGatewayClientUploadCommitGuard({
      method: "agents.update",
      requestParams: params,
      client,
      context,
    });
    let identityPublished = false;
    const assertUploadAllowed = () => {
      if (!identityPublished) {
        assertUploadCurrent?.();
      }
    };
    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    const workspace = resolveOptionalStringParam(params.workspace);
    const workspaceDir = workspace ? resolveUserPath(workspace) : undefined;

    const model = params.model === null ? null : resolveOptionalStringParam(params.model);

    const name = resolveOptionalStringParam(params.name);
    const safeName = name ? sanitizeAgentIdentityLine(name) : undefined;

    const identity = createAgentIdentityConfig({
      name: safeName,
      emoji: params.emoji,
      avatar: params.avatar,
    });
    const hasIdentityFields = Boolean(identity);

    const agentConfigUpdate: Parameters<typeof updateAgentConfigEntry>[0] = {
      agentId,
      ...(safeName ? { name: safeName } : {}),
      ...(workspaceDir ? { workspace: workspaceDir } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
      ...(identity ? { identity } : {}),
    };
    const selectionError = validateAgentModelSelectionUpdate(params);
    if (selectionError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selectionError));
      return;
    }
    const configured = isConfiguredAgent(cfg, agentId);
    if (!configured && !isImplicitAgentModelUpdate(cfg, agentConfigUpdate)) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    const nextConfig = configured ? applyAgentConfig(cfg, agentConfigUpdate) : cfg;
    const application = createAgentConfigApplication(respond);

    try {
      let ensuredWorkspace: Awaited<ReturnType<typeof ensureAgentWorkspace>> | undefined;
      if (workspaceDir) {
        await assertAgentDeletionTargetsUnchanged(cfg, nextConfig);
        const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
        ensuredWorkspace = await ensureAgentWorkspace({
          dir: workspaceDir,
          guard: { assertHost: assertUploadAllowed },
          ensureBootstrapFiles: !skipBootstrap,
          skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
        });
      }

      const persistedIdentity = normalizeIdentityForFile(resolveAgentIdentity(nextConfig, agentId));
      if (persistedIdentity && (workspaceDir || hasIdentityFields)) {
        const identityWorkspaceDir = resolveAgentWorkspaceDir(nextConfig, agentId);
        const previousWorkspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const fallbackWorkspaceDir =
          workspaceDir && identityWorkspaceDir !== previousWorkspaceDir
            ? previousWorkspaceDir
            : undefined;
        // A workspace service may be replaced while the identity read is awaiting I/O.
        // Keep both the source and destination pinned for this read/merge/write.
        const workspaceAccess = [
          identityWorkspaceDir,
          ...(fallbackWorkspaceDir ? [fallbackWorkspaceDir] : []),
        ].map((dir) => [dir, getAgentWorkspaceAccess(dir)] as const);
        const assertWorkspaceAccessCurrent = () => {
          assertUploadAllowed?.();
          for (const [dir, access] of workspaceAccess) {
            if (getAgentWorkspaceAccess(dir) !== access) {
              throw new Error("Workspace access changed while updating Agent identity");
            }
          }
        };
        const identityContent = await buildIdentityMarkdownOrRespondUnsafe({
          respond,
          workspaceDir: identityWorkspaceDir,
          identity: persistedIdentity,
          fallbackWorkspaceDir,
          preferFallbackWorkspaceContent:
            Boolean(fallbackWorkspaceDir) && ensuredWorkspace?.identityPathCreated === true,
        });
        if (identityContent === null) {
          return;
        }
        assertWorkspaceAccessCurrent();
        if (
          !(await writeWorkspaceFileOrRespond({
            respond,
            workspaceDir: identityWorkspaceDir,
            name: DEFAULT_IDENTITY_FILENAME,
            content: identityContent,
            assertCurrent: assertWorkspaceAccessCurrent,
          }))
        ) {
          return;
        }
        // The write accepted these exact bytes. Settle their config projection,
        // without retiring workspace authority or admitting another upload.
        identityPublished = true;
        assertWorkspaceAccessCurrent();
      }

      await updateAgentConfigEntry(
        { ...agentConfigUpdate, assertCurrent: assertUploadAllowed },
        application.attach({}),
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      if (
        error instanceof AgentModelSelectionError ||
        error instanceof AgentDeletionTargetsPendingError
      ) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
        return;
      }
      throw error;
    }

    if (await application.confirm()) {
      respond(true, { ok: true, agentId }, undefined);
    }
  },
  "agents.delete": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateAgentsDeleteParams, "agents.delete", respond)) {
      return;
    }

    const cfg = context.getRuntimeConfig();
    const normalized = normalizeAgentIdStrict(params.agentId);
    if (!normalized.ok) {
      respondAgentNotFound(respond, params.agentId);
      return;
    }
    const agentId = normalized.value;
    if (agentOwnsSharedAuthStore(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatSharedAuthStoreOwnerDeleteError(agentId)),
      );
      return;
    }
    const existingJournal = await readAgentDeletionJournalAsync(agentId);
    if (
      !isConfiguredAgent(cfg, agentId) &&
      (!existingJournal || existingJournal.cleanupCompleted)
    ) {
      respondAgentNotFound(respond, agentId);
      return;
    }
    if (agentId === tryResolveSoleAgentId(cfg)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" is the only configured agent and cannot be deleted.`,
        ),
      );
      return;
    }
    if (isInheritedAuthStoreOwner(cfg, agentId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Agent "${agentId}" owns inherited credentials through agents.defaults.authInheritance.agentId and cannot be deleted. Relocate those credentials, then re-point or remove that binding before retrying.`,
        ),
      );
      return;
    }

    const requestedDeleteFiles = params.deleteFiles ?? true;
    const application = createAgentConfigApplication(respond);
    try {
      const result = await deleteGatewayAgent(agentId, requestedDeleteFiles, context, {
        writeOptions: application.attach({}),
      });
      // Reload may need the mutation/deletion leases; wait only after they settle.
      if (!(await application.confirm())) {
        return;
      }
      if (result.purgeFailed || result.failed?.length) {
        const failures = result.failed?.map(({ path, reason }) => `${path}: ${reason}`) ?? [];
        if (result.purgeFailed) {
          failures.unshift("session-store cleanup failed");
        }
        respond(
          false,
          result,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Agent "${agentId}" was removed from configuration, but deletion cleanup is still pending: ${failures.join("; ")}. Resolve the cleanup failure, then retry agents.delete.`,
          ),
        );
        return;
      }
      respond(true, result, undefined);
    } catch (error) {
      if (
        error instanceof AgentSharedAuthStoreOwnerError ||
        error instanceof AgentSharedStoreOwnerError
      ) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (error instanceof AgentConfigPreconditionError) {
        respondAgentNotFound(respond, agentId);
        return;
      }
      throw error;
    }
  },
  ...agentFileHandlers,
};
