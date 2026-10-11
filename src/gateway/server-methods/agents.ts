import path from "node:path";
import { normalizeOptionalString as resolveOptionalStringParam } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateAgentsCreateParams,
  validateAgentsDeleteParams,
  validateAgentsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AgentsDeleteResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
  AgentSharedStoreOwnerError,
  assertAgentSessionStoreDeletionSafe,
  finishAgentDeleteDatabases,
  isPathOwnedBySurvivingAgent,
  prepareAgentDeleteDatabases,
  prepareJournaledAgentDirOwnership,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
  retireAgentDeleteRuntime,
  type AgentDeleteDatabasePlan,
} from "../../agents/agent-delete-databases.js";
import {
  formatSharedAuthStoreOwnerDeleteError,
  isInheritedAuthStoreOwner,
  isSharedAuthStoreOwner,
} from "../../agents/agent-delete-safety.js";
import {
  normalizeAgentDirRegistryPath,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "../../agents/agent-dir-registry.js";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
  withAgentDeletion,
  claimCompletedAgentDeletion,
} from "../../agents/agent-lifecycle-registry.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveSoleAgentId,
} from "../../agents/agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import {
  createAgentIdentityConfig,
  normalizeIdentityForFile,
  sanitizeAgentIdentityLine,
} from "../../agents/identity-file.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../../agents/workspace-state-store.js";
import { DEFAULT_IDENTITY_FILENAME, ensureAgentWorkspace } from "../../agents/workspace.js";
import { applyAgentConfig } from "../../commands/agents.config.js";
import {
  readConfigFileSnapshotForWrite,
  withConfigMutationExclusive,
} from "../../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import { purgeAgentSessionStoreEntries } from "../../config/sessions.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { withAgentExecApprovalsRemoved } from "../../infra/exec-approvals.js";
import { isPathInside } from "../../infra/path-guards.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { normalizeAgentIdStrict } from "../../routing/session-key.js";
import {
  readAgentDeletionJournalAsync,
  type AgentDeletionJournalCleanupPath,
} from "../../state/agent-deletion-journal.js";
import { resolveUserPath } from "../../utils.js";
import { reviveAgentDatabasesAfterConfigCommit } from "../server-reload-agent-databases.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import {
  AgentConfigPreconditionError,
  AgentModelSelectionError,
  createAgentConfigEntry,
  deleteAgentConfigEntry,
  isConfiguredAgent,
  isImplicitAgentModelUpdate,
  updateAgentConfigEntry,
  validateAgentModelSelectionUpdate,
} from "./agents-config-mutations.js";
import {
  AgentCleanupIdentityMismatchError,
  cleanupFailure,
  cleanupPathCovers,
  prepareAgentDeleteCleanupPaths,
  removeAgentPath,
  statAgentCleanupPath,
  type AgentDeleteCleanupPath,
} from "./agents-delete-filesystem.js";
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

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];

class AgentSharedAuthStoreOwnerError extends Error {}

function agentOwnsSharedAuthStore(cfg: OpenClawConfig, agentId: string): boolean {
  const agentDir = resolveAgentDir(cfg, agentId);
  return isSharedAuthStoreOwner({
    ownership: resolveSharedAuthStoreOwnership(),
    agentAuthDbPath: resolveAuthProfileDatabasePath(agentDir),
    sharedAuthDbPath: resolveSharedAuthStorePath(),
  });
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
      if (error instanceof AgentModelSelectionError) {
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
      const result = await withAgentDeletion(agentId, async (begin) =>
        withConfigMutationExclusive(async (lockedConfig) => {
          await assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
          let lockedJournal = await readAgentDeletionJournalAsync(agentId);
          const configured = isConfiguredAgent(lockedConfig, agentId);
          if (agentOwnsSharedAuthStore(lockedConfig, agentId)) {
            throw new AgentSharedAuthStoreOwnerError(
              formatSharedAuthStoreOwnerDeleteError(agentId),
            );
          }
          if (!configured && (!lockedJournal || lockedJournal.cleanupCompleted)) {
            throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
          }
          if (agentId === tryResolveSoleAgentId(lockedConfig)) {
            throw new AgentConfigPreconditionError(
              `agent "${agentId}" is the only configured agent`,
            );
          }
          if (isInheritedAuthStoreOwner(lockedConfig, agentId)) {
            throw new AgentConfigPreconditionError(
              `agent "${agentId}" owns agents.defaults.authInheritance.agentId; relocate credentials and re-point it first`,
            );
          }
          if (configured && lockedJournal?.cleanupCompleted) {
            const claimed = await claimCompletedAgentDeletion(agentId, lockedJournal.operationId);
            const remainingJournal = await readAgentDeletionJournalAsync(agentId);
            if (!claimed && remainingJournal) {
              throw new Error(
                `agent "${agentId}" deletion tombstone changed before fresh deletion`,
              );
            }
            lockedJournal = undefined;
          }
          const deleteFiles = lockedJournal?.deleteFiles ?? requestedDeleteFiles;
          const deletion = await begin(
            lockedJournal ?? {
              agentId,
              agentDir: resolveAgentDir(lockedConfig, agentId),
              workspaceDir: resolveAgentWorkspaceDir(lockedConfig, agentId),
              sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
              deleteFiles,
            },
          );
          const journal = deletion.entry;
          let rosterCommitted = !configured;
          let committed: Awaited<ReturnType<typeof deleteAgentConfigEntry>> | undefined;
          let databasePlan: AgentDeleteDatabasePlan | undefined;
          try {
            prepareJournaledAgentDirOwnership(lockedConfig, agentId, journal.agentDir);
            databasePlan = await prepareAgentDeleteDatabases(
              lockedConfig,
              agentId,
              journal.agentDir,
              {},
              deletion,
            );
            await deletion.assertCurrentAsync();
            await deletion.fenceDatabasePaths([
              ...journal.databasePaths,
              ...databasePlan.fileGroups.flat(),
            ]);
            if (deleteFiles) {
              const fencedSourcePaths = new Set(
                journal.cleanupPaths.flatMap((cleanupPath) =>
                  cleanupPath.sourcePaths.map((sourcePath) => path.resolve(sourcePath)),
                ),
              );
              const unfencedSourcePaths = [
                journal.workspaceDir,
                journal.agentDir,
                journal.sessionsDir,
                ...journal.databasePaths,
              ].filter((sourcePath) => !fencedSourcePaths.has(path.resolve(sourcePath)));
              if (unfencedSourcePaths.length > 0) {
                const unfencedSourcePathSet = new Set(
                  unfencedSourcePaths.map((sourcePath) => path.resolve(sourcePath)),
                );
                const cleanupPlan = await prepareAgentDeleteCleanupPaths(
                  unfencedSourcePaths,
                  journal.cleanupPaths,
                );
                const unresolvedPath = cleanupPlan.find(
                  (cleanupPath) =>
                    cleanupPath.preparationError !== undefined &&
                    cleanupPath.sourcePaths.some((sourcePath) =>
                      unfencedSourcePathSet.has(path.resolve(sourcePath)),
                    ),
                );
                if (unresolvedPath) {
                  throw unresolvedPath.preparationError;
                }
                await deletion.fenceCleanupPaths(
                  cleanupPlan.map((cleanupPath) => {
                    const journalPath: AgentDeletionJournalCleanupPath = {
                      path: cleanupPath.path,
                      canonicalPath: cleanupPath.trashPath,
                      parentPath: cleanupPath.parentPath,
                      kind: cleanupPath.kind,
                      sourcePaths: cleanupPath.sourcePaths,
                      dev: cleanupPath.preparedIdentity?.dev ?? null,
                      ino: cleanupPath.preparedIdentity?.ino ?? null,
                      coversDescendants: cleanupPath.trashCoversDescendants,
                      done: cleanupPath.done,
                    };
                    if (cleanupPath.note) {
                      journalPath.note = cleanupPath.note;
                    }
                    return journalPath;
                  }),
                );
              }
            }
            await context.cron.removeAgentJobsTransactional(agentId, () =>
              withAgentExecApprovalsRemoved(
                agentId,
                async () => {
                  await deletion.assertCurrentAsync();
                  try {
                    committed = await deleteAgentConfigEntry({
                      agentId,
                      allowMissing: !configured,
                      allowConfigSizeDrop: true,
                      assertCurrent: deletion.assertCurrentFinal,
                      assertCurrentAsync: deletion.assertCurrentAsync,
                      writeOptions: application.attach({}),
                    });
                  } catch (error) {
                    try {
                      const persisted = await readConfigFileSnapshotForWrite();
                      if (!isConfiguredAgent(persisted.snapshot.sourceConfig, agentId)) {
                        rosterCommitted = true;
                        throw new AgentDeletionCommitUncertainError(error);
                      }
                    } catch (readError) {
                      if (readError instanceof AgentDeletionCommitUncertainError) {
                        throw readError;
                      }
                      throw new AgentDeletionCommitUncertainError(error);
                    }
                    throw error;
                  }
                  if (configured && !committed.result) {
                    rosterCommitted = !isConfiguredAgent(committed.nextConfig, agentId);
                    const missingResultError = new Error(
                      "agent delete config mutation did not return its target",
                    );
                    if (rosterCommitted) {
                      throw new AgentDeletionCommitUncertainError(missingResultError);
                    }
                    throw missingResultError;
                  }
                  rosterCommitted = true;
                },
                deletion,
              ),
            );
            await deletion.assertCurrentAsync();
          } catch (error) {
            let canReleaseFence =
              !rosterCommitted &&
              !lockedJournal &&
              !(error instanceof AgentDeletionAuthorityRollbackError) &&
              !(error instanceof AgentDeletionCommitUncertainError);
            if (canReleaseFence) {
              try {
                const persisted = await readConfigFileSnapshotForWrite();
                canReleaseFence = isConfiguredAgent(persisted.snapshot.sourceConfig, agentId);
              } catch {
                canReleaseFence = false;
              }
            }
            if (canReleaseFence) {
              await deletion.rollback();
            }
            throw error;
          }

          await retireAgentDeleteRuntime(
            lockedConfig,
            deletion,
            databasePlan?.agentDirs ?? [journal.agentDir],
          );

          const deleteResult = committed?.result ?? {
            agentDir: journal.agentDir,
            workspaceDir: journal.workspaceDir,
            sessionsDir: journal.sessionsDir,
            removedBindings: 0,
          };
          const nextConfig = committed?.nextConfig ?? lockedConfig;

          // A journaled path is trash-eligible only while registry ownership still points at the
          // deleted agent; recovery must not consume a path claimed by a surviving agent.
          const agentDirRegistryPath = normalizeAgentDirRegistryPath(deleteResult.agentDir);
          const purgeFailed = await purgeAgentSessionStoreEntries(lockedConfig, agentId, {
            runDatabaseCleanup: deletion.runDatabaseCleanup,
          });
          await deletion.assertCurrentAsync();
          const { closeDeletedAgentDatabases } =
            await import("../../state/openclaw-agent-db-readers.js");
          const readerPaths = databasePlan?.readerPaths ?? [];
          await closeDeletedAgentDatabases(agentId, readerPaths, deletion);

          const removed: AgentDeleteRemovedPath[] = [];
          const failed: AgentDeleteFailedPath[] = [];

          if (deleteFiles && !purgeFailed) {
            const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
              await readAgentDeleteDatabaseRegistry(),
              agentId,
            );
            const unclaimedBySurvivor = (pathname: string) =>
              !isPathOwnedBySurvivingAgent(
                nextConfig,
                agentId,
                pathname,
                survivingDatabaseFilePaths,
              );
            const workspaceTrashEligible = unclaimedBySurvivor(deleteResult.workspaceDir);
            // The config mutation lock and durable journal fence block new roster and database
            // claims across this final ownership recheck and the filesystem cleanup below.
            const agentDirTrashEligible =
              resolveRegisteredAgentIdForDir(deleteResult.agentDir) === agentId &&
              unclaimedBySurvivor(deleteResult.agentDir);
            const sessionsDirTrashEligible = unclaimedBySurvivor(deleteResult.sessionsDir);
            const databaseFilePaths = [
              ...(agentDirTrashEligible
                ? (databasePlan?.relocatedFileGroups ?? [])
                : (databasePlan?.fileGroups ?? [])
              ).flat(),
              ...journal.databasePaths,
            ].filter(unclaimedBySurvivor);
            const eligibleSourcePaths = new Set(
              [
                ...(workspaceTrashEligible ? [deleteResult.workspaceDir] : []),
                ...(agentDirTrashEligible ? [deleteResult.agentDir] : []),
                ...(sessionsDirTrashEligible ? [deleteResult.sessionsDir] : []),
                ...databaseFilePaths,
              ].map((sourcePath) => path.resolve(sourcePath)),
            );
            const cleanupPaths = (
              await prepareAgentDeleteCleanupPaths([], journal.cleanupPaths)
            ).filter(
              (cleanupPath) =>
                cleanupPath.sourcePaths.some((sourcePath) => eligibleSourcePaths.has(sourcePath)) &&
                (agentDirTrashEligible ||
                  !cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath)),
            );
            const workspaceCanonicalPath = normalizeAgentDirRegistryPath(deleteResult.workspaceDir);
            const workspaceCleanupPaths = cleanupPaths.filter((cleanupPath) =>
              cleanupPathCovers(cleanupPath, deleteResult.workspaceDir, workspaceCanonicalPath),
            );
            const legacyPlan =
              workspaceCleanupPaths.length > 0
                ? prepareLegacyWorkspaceStateReset(deleteResult.workspaceDir)
                : undefined;
            const statePlan =
              workspaceCleanupPaths.length > 0
                ? prepareWorkspaceStateDeletion(deleteResult.workspaceDir)
                : undefined;
            const markCleanupPathDone = async (
              cleanupPath: AgentDeleteCleanupPath,
              note?: string,
            ) => {
              const canonicalPath = path.resolve(cleanupPath.trashPath);
              await deletion.fenceCleanupPaths(
                journal.cleanupPaths.map((entry) => {
                  if (
                    path.resolve(entry.canonicalPath) !== canonicalPath ||
                    entry.kind !== cleanupPath.kind
                  ) {
                    return entry;
                  }
                  const updated = Object.assign({}, entry, { done: true });
                  if (note) {
                    updated.note = note;
                  }
                  return updated;
                }),
              );
              cleanupPath.done = true;
              cleanupPath.note = note;
            };
            const protectedCleanupPaths: Array<{
              cleanupPath: AgentDeleteCleanupPath;
              protectAliases: boolean;
              terminal: boolean;
              note?: string;
            }> = [];
            for (const cleanupPath of cleanupPaths) {
              await deletion.assertCurrentAsync();
              if (cleanupPath.done) {
                let replacementPresent = true;
                let note =
                  cleanupPath.note ?? "completed cleanup path is occupied; replacement preserved";
                try {
                  await statAgentCleanupPath(cleanupPath);
                } catch (error) {
                  if (isMissingPathError(error)) {
                    replacementPresent = false;
                  } else if (!(error instanceof AgentCleanupIdentityMismatchError)) {
                    note = "completed cleanup path could not be verified; replacement preserved";
                  }
                }
                if (replacementPresent) {
                  await markCleanupPathDone(cleanupPath, note);
                  protectedCleanupPaths.push({
                    cleanupPath,
                    protectAliases: true,
                    terminal: true,
                    note,
                  });
                }
                continue;
              }
              const refreshedDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
                await readAgentDeleteDatabaseRegistry(),
                agentId,
              );
              const blockingProtection = protectedCleanupPaths.find(
                ({ cleanupPath: protectedPath, protectAliases }) =>
                  ((cleanupPath.kind !== "symlink" || protectAliases) &&
                    (protectedPath.canonicalPath === cleanupPath.canonicalPath ||
                      isPathInside(cleanupPath.canonicalPath, protectedPath.canonicalPath))) ||
                  [
                    protectedPath.trashPath,
                    ...(protectAliases ? protectedPath.sourcePaths : []),
                  ].some(
                    (protectedSourcePath) =>
                      protectedSourcePath === cleanupPath.trashPath ||
                      isPathInside(cleanupPath.trashPath, protectedSourcePath),
                  ),
              );
              const ownedBySurvivor =
                isPathOwnedBySurvivingAgent(
                  nextConfig,
                  agentId,
                  cleanupPath.path,
                  refreshedDatabaseFilePaths,
                ) ||
                (cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath) &&
                  resolveRegisteredAgentIdForDir(deleteResult.agentDir) !== agentId);
              if (blockingProtection || ownedBySurvivor) {
                const terminal = ownedBySurvivor || blockingProtection?.terminal === true;
                const note = ownedBySurvivor
                  ? "replacement owned by a surviving agent"
                  : blockingProtection?.note;
                if (terminal) {
                  await markCleanupPathDone(cleanupPath, note ?? "protected replacement preserved");
                }
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: blockingProtection?.protectAliases ?? false,
                  terminal,
                  note,
                });
                continue;
              }
              const outcome = cleanupPath.preparationError
                ? cleanupFailure(cleanupPath.path, cleanupPath.preparationError)
                : await removeAgentPath(cleanupPath, deletion);
              if ("removed" in outcome) {
                removed.push(outcome.removed);
                await markCleanupPathDone(cleanupPath);
              } else if ("skipped" in outcome) {
                await markCleanupPathDone(cleanupPath, outcome.skipped.reason);
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: true,
                  note: outcome.skipped.reason,
                });
              } else {
                failed.push(outcome.failed);
                protectedCleanupPaths.push({
                  cleanupPath,
                  protectAliases: true,
                  terminal: false,
                });
              }
            }
            if (
              workspaceCleanupPaths.length > 0 &&
              workspaceCleanupPaths.every((cleanupPath) => cleanupPath.done) &&
              legacyPlan &&
              statePlan
            ) {
              try {
                await removeLegacyWorkspaceStateForReset(legacyPlan, {
                  assertCurrent: deletion.assertCurrentFinal,
                });
                await deletion.assertCurrentAsync();
                await deleteWorkspaceState(statePlan, { deletion });
              } catch {
                // Best-effort cleanup. A later explicit reset can remove stale rows.
              }
            }
            await deletion.assertCurrentAsync();
            const agentDirCleanupPaths = cleanupPaths.filter((cleanupPath) =>
              cleanupPathCovers(cleanupPath, deleteResult.agentDir, agentDirRegistryPath),
            );
            if (
              agentDirCleanupPaths.length > 0 &&
              agentDirCleanupPaths.every((cleanupPath) => cleanupPath.done)
            ) {
              unregisterResolvedAgentDir({ agentId, agentDir: agentDirRegistryPath });
            }
          }
          await finishAgentDeleteDatabases({
            deletion,
            agentDir: agentDirRegistryPath,
            deleteFiles,
            complete: failed.length === 0 && !purgeFailed,
          });
          return {
            ok: true,
            agentId,
            removedBindings: deleteResult.removedBindings,
            removed,
            failed,
            ...(purgeFailed ? { purgeFailed: true as const } : {}),
          };
        }),
      );
      // Reload may need the mutation/deletion leases; wait only after they settle.
      if (!(await application.confirm())) {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
