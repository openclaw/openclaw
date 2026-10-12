import path from "node:path";
import type { AgentsDeleteResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import {
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
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../../agents/workspace-state-store.js";
import {
  readConfigFileSnapshotForWrite,
  withConfigMutationExclusive,
} from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import { purgeAgentSessionStoreEntries } from "../../config/sessions.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { withAgentExecApprovalsRemoved } from "../../infra/exec-approvals.js";
import { isPathInside } from "../../infra/path-guards.js";
import { closeAgentWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import {
  readAgentDeletionJournalAsync,
  type AgentDeletionJournalCleanupPath,
} from "../../state/agent-deletion-journal.js";
import {
  AgentConfigPreconditionError,
  deleteAgentConfigEntry,
  isConfiguredAgent,
} from "./agents-config-mutations.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import {
  AgentCleanupIdentityMismatchError,
  cleanupFailure,
  cleanupPathCovers,
  prepareAgentDeleteCleanupPaths,
  removeAgentPath,
  statAgentCleanupPath,
  type AgentDeleteCleanupPath,
} from "./agents-delete-filesystem.js";
import type { GatewayRequestContext } from "./types.js";

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];

export class AgentSharedAuthStoreOwnerError extends Error {}

export function agentOwnsSharedAuthStore(cfg: OpenClawConfig, agentId: string): boolean {
  const agentDir = resolveAgentDir(cfg, agentId);
  return isSharedAuthStoreOwner({
    ownership: resolveSharedAuthStoreOwnership(),
    agentAuthDbPath: resolveAuthProfileDatabasePath(agentDir),
    sharedAuthDbPath: resolveSharedAuthStorePath(),
  });
}

/** RPC and restart recovery share the exact journal, retirement, and filesystem owner. */
export async function deleteGatewayAgent(
  agentId: string,
  requestedDeleteFiles: boolean,
  context: GatewayRequestContext,
  options: { recoveryOperationId?: string; writeOptions?: ConfigWriteOptions } = {},
): Promise<AgentsDeleteResult> {
  const { recoveryOperationId, writeOptions } = options;
  let releaseIngress: (() => void) | undefined;
  try {
    return await withAgentDeletion(agentId, async (begin) => {
      const prepared = await withConfigMutationExclusive(async (lockedConfig) => {
        await assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
        let lockedJournal = await readAgentDeletionJournalAsync(agentId);
        if (
          recoveryOperationId &&
          (lockedJournal?.operationId !== recoveryOperationId || lockedJournal.cleanupCompleted)
        ) {
          throw new Error(`Agent ${agentId} deletion recovery no longer owns its journal.`);
        }
        const configured = isConfiguredAgent(lockedConfig, agentId);
        if (agentOwnsSharedAuthStore(lockedConfig, agentId)) {
          throw new AgentSharedAuthStoreOwnerError(formatSharedAuthStoreOwnerDeleteError(agentId));
        }
        if (!configured && (!lockedJournal || lockedJournal.cleanupCompleted)) {
          throw new AgentConfigPreconditionError(`agent "${agentId}" not found`);
        }
        if (agentId === tryResolveSoleAgentId(lockedConfig)) {
          throw new AgentConfigPreconditionError(`agent "${agentId}" is the only configured agent`);
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
            throw new Error(`agent "${agentId}" deletion tombstone changed before fresh deletion`);
          }
          lockedJournal = undefined;
        }
        const deleteFiles = lockedJournal?.deleteFiles ?? requestedDeleteFiles;
        releaseIngress = closeAgentWorkAdmissions({
          agentId,
          reason: new Error(`Agent ${agentId} deletion is draining active work.`),
        });
        const deletion = await begin(
          lockedJournal ?? {
            agentId,
            agentDir: resolveAgentDir(lockedConfig, agentId),
            workspaceDir: resolveAgentWorkspaceDir(lockedConfig, agentId),
            sessionsDir: resolveSessionTranscriptsDirForAgent(agentId),
            deleteFiles,
            phase: "draining",
          },
          { recoveryOperationId },
        );
        return { deletion, lockedJournal, config: lockedConfig };
      });
      const { deletion, lockedJournal } = prepared;
      const journal = deletion.entry;
      if (journal.phase === "draining") {
        await drainAgentDeletionRuns(
          agentId,
          prepared.config,
          context,
          deletion.assertCurrentFinal,
        );
      }
      const { closeActiveMemorySearchManagerCore } =
        await import("../../plugins/memory-runtime.js");
      await deletion.assertCurrentAsync();
      await closeActiveMemorySearchManagerCore({ cfg: prepared.config, agentId });
      await deletion.assertCurrentAsync();
      if (journal.phase === "draining") {
        await deletion.retire();
      }
      return await withConfigMutationExclusive(async (lockedConfig) => {
        const configured = isConfiguredAgent(lockedConfig, agentId);
        const deleteFiles = journal.deleteFiles;
        let rosterCommitted = !configured;
        let committed: Awaited<ReturnType<typeof deleteAgentConfigEntry>> | undefined;
        let databasePlan: AgentDeleteDatabasePlan | undefined;
        try {
          await deletion.assertCurrentAsync();
          await assertAgentSessionStoreDeletionSafe(lockedConfig, agentId);
          if (
            agentOwnsSharedAuthStore(lockedConfig, agentId) ||
            isInheritedAuthStoreOwner(lockedConfig, agentId)
          ) {
            throw new AgentSharedAuthStoreOwnerError(
              formatSharedAuthStoreOwnerDeleteError(agentId),
            );
          }
          if (agentId === tryResolveSoleAgentId(lockedConfig)) {
            throw new AgentConfigPreconditionError(
              `agent "${agentId}" is the only configured agent`,
            );
          }
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
                    writeOptions,
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

        await retireAgentDeleteRuntime(deletion, databasePlan?.agentDirs ?? [journal.agentDir]);

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
        const failed: AgentDeleteFailedPath[] = [];
        const purgeFailed = await purgeAgentSessionStoreEntries(lockedConfig, agentId, {
          runDatabaseCleanup: deletion.runDatabaseCleanup,
          onFailure: (failure) => failed.push(failure),
        });
        await deletion.assertCurrentAsync();
        const { closeDeletedAgentDatabases } =
          await import("../../state/openclaw-agent-db-readers.js");
        const readerPaths = databasePlan?.readerPaths ?? [];
        await closeDeletedAgentDatabases(agentId, readerPaths, deletion);

        const removed: AgentDeleteRemovedPath[] = [];

        if (deleteFiles && !purgeFailed) {
          const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
            await readAgentDeleteDatabaseRegistry(),
            agentId,
          );
          const unclaimedBySurvivor = (pathname: string) =>
            !isPathOwnedBySurvivingAgent(nextConfig, agentId, pathname, survivingDatabaseFilePaths);
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
      });
    });
  } finally {
    releaseIngress?.();
  }
}
