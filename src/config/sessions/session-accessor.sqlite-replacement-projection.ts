import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { deferOpenClawAgentPostCommitPublication } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  supportsOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { withNativeSessionCommitContext } from "./session-accessor.sqlite-commit-context.js";
import type {
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  runPreparedSqliteSessionWrite,
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
} from "./session-accessor.sqlite-deletion.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import { finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { commitSessionEntryReplacementsInDatabase } from "./session-accessor.sqlite-replacement-state.js";
import type {
  SqliteSessionEntryReplacement,
  SessionEntryReplacementCommit,
} from "./session-accessor.sqlite-replacement-types.js";
import {
  commitSessionEntryReplacementsInWorker,
  prepareSessionEntryReplacementDatabase,
} from "./session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteScope,
  resolveSqliteWriteAdmissionScope,
  prepareSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryCommitContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryReplacement,
} from "./session-accessor.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";

export type SessionEntryCanonicalReplacement = SessionEntryReplacement & {
  previousSessionKeys: readonly string[];
};

type ReplacementProjectionOptions = {
  retainedExecution?: OpenClawAgentDatabaseExecution;
  assertCommitAllowed?: () => void;
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"];
  ownerAssignment?: SessionEntryReplacementCommit["ownerAssignment"];
  labelClaim?: SessionEntryReplacementCommit["labelClaim"];
  preparedTranscript?: SessionEntryReplacementCommit["preparedTranscript"];
  checkPendingArchiveRecovery?: boolean;
  onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  env?: NodeJS.ProcessEnv;
  activeSessionKey?: string;
  agentId?: string;
  consumePendingReset?: boolean;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  includeLabelOwners?: string;
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
};

type ReplacementProjectionParams<T, TReplacement> = ReplacementProjectionOptions & {
  afterCommitted?: (result: T, context: SessionEntryCommitContext) => Promise<void>;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) =>
    | Promise<{ result: T; replacements?: Iterable<TReplacement> }>
    | { result: T; replacements?: Iterable<TReplacement> };
};

async function applySqliteSessionEntryReplacementProjection<T, TReplacement>(
  params: ReplacementProjectionParams<T, TReplacement>,
  normalize: (replacements: Iterable<TReplacement> | undefined) => SqliteSessionEntryReplacement[],
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const target = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
    env,
  };
  const admission = isMainThread ? resolveSqliteWriteAdmissionScope(target) : undefined;
  const scope =
    admission ?? (isMainThread ? await prepareSqliteScope(target) : resolveSqliteScope(target));
  scope.path ??= resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const preparedWrite = await runPreparedSqliteSessionWrite(
    scope,
    async (preparedScope) => {
      const resolved = { ...preparedScope, env };
      const databaseOptions = {
        ...toDatabaseOptions(resolved),
        path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
      };
      const useWorker = isMainThread && supportsOpenClawAgentDatabaseExecution(databaseOptions);
      const readNative = () =>
        withSqliteSessionDatabase(databaseOptions, (database) => ({
          ...readSessionEntryReplacementState(database, params),
          databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
        }));
      const snapshot = useWorker
        ? await withSessionHistoryWorkerDatabase(databaseOptions, async (owner) => {
            const read = () =>
              owner.readExactEntries({
                sessionKeys: params.sessionKeys ?? [],
                projection: "replacement",
                replacementSelection: {
                  sessionKeys: params.sessionKeys,
                  statuses: params.statuses,
                  includeLabelOwners: params.includeLabelOwners,
                },
                env: { ...resolved.env },
              });
            let result = await read();
            if (!result.replacement) {
              await prepareSessionEntryReplacementDatabase(
                databaseOptions,
                () => {
                  owner.assertCurrent();
                  params.assertCommitAllowed?.();
                },
                params.retainedExecution,
              );
              result = await read();
            }
            if (!result.replacement) {
              throw new Error("Session replacement snapshot lost its initialized database");
            }
            return result.replacement;
          })
        : await readNative();
      const { entries, expectedRows, labelOwnerKeys } = snapshot;
      const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
      const selectedStatuses = params.statuses ? new Set(params.statuses) : undefined;
      const replacementAuthorityKeys = selectedStatuses
        ? new Set(entries.map(({ sessionKey }) => sessionKey))
        : selectedKeys;
      const operation = await params.update(entries);
      const replacements = normalize(operation.replacements);
      const claimedCanonicalKeys = new Set<string>();
      for (const replacement of replacements) {
        const previousSessionKeys = replacement.previousSessionKeys;
        const canonical = previousSessionKeys !== undefined;
        if (canonical && !replacement.sessionKey) {
          throw new Error("Session entry replacement requires a key");
        }
        if (
          canonical &&
          [replacement.sessionKey, ...(previousSessionKeys ?? [])].some(isInternalSessionEffectsKey)
        ) {
          throw new Error(
            "Session entry canonical replacement cannot target internal effects rows",
          );
        }
        for (const sessionKey of [replacement.sessionKey, ...(previousSessionKeys ?? [])]) {
          if (replacementAuthorityKeys && !replacementAuthorityKeys.has(sessionKey)) {
            const selectionName = selectedStatuses ? "row" : "key";
            throw new Error(
              `Session entry replacement is outside the selected ${selectionName} set: ${sessionKey}`,
            );
          }
          if (canonical) {
            if (claimedCanonicalKeys.has(sessionKey)) {
              throw new Error(`Session entry replacements overlap at ${sessionKey}`);
            }
            claimedCanonicalKeys.add(sessionKey);
          }
        }
        if (canonical) {
          for (const previousSessionKey of previousSessionKeys) {
            if (!expectedRows.has(previousSessionKey)) {
              throw new Error(
                `Session entry canonical projection cannot replace missing alias ${previousSessionKey}`,
              );
            }
          }
        }
      }

      const applicable = replacements.filter(
        (replacement) =>
          replacement.previousSessionKeys || expectedRows.has(replacement.sessionKey),
      );
      if (params.requireWriteSuccess && replacements.length > 0 && applicable.length === 0) {
        throw new Error("session entry replacements did not persist any rows");
      }
      if (applicable.length === 0) {
        return {
          deletedEntries: [],
          commit: () => ({ maintenancePlans: [], result: operation.result }),
        };
      }
      const mutationKeys = new Set(
        applicable.flatMap((replacement) => [
          replacement.sessionKey,
          ...(replacement.previousSessionKeys ?? []),
        ]),
      );
      // Read-only label owners need the same row CAS as targets: their label can
      // change between key selection and hydration, then change back during planning.
      const validationKeys = new Set([...mutationKeys, ...labelOwnerKeys]);

      const deletedOwners = [...mutationKeys].flatMap((sessionKey) => {
        const entry = expectedRows.get(sessionKey)?.entry;
        return entry && !applicable.some((replacement) => replacement.sessionKey === sessionKey)
          ? [{ entry, sessionKey }]
          : [];
      });
      return {
        deletedEntries: deletedOwners,
        commit: async (assertSourceCurrent) => {
          const maintenance =
            params.skipMaintenance === false
              ? {
                  activeSessionKey: params.activeSessionKey ?? "",
                  archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                  maintenance: resolveMaintenanceConfig(),
                  preservation: captureSessionMaintenancePreservation(params.storePath),
                  storePath: params.storePath,
                }
              : undefined;
          const assertCurrent = () => {
            assertSourceCurrent?.();
            params.assertCommitAllowed?.();
            if (
              maintenance &&
              !isDeepStrictEqual(
                maintenance.preservation,
                captureSessionMaintenancePreservation(params.storePath),
              )
            ) {
              throw new Error("Session maintenance protection changed before replacement");
            }
          };
          const input: SessionEntryReplacementCommit = {
            expectedRows,
            labelOwnerKeys,
            includeLabelOwners: params.includeLabelOwners,
            validationKeys: [...validationKeys],
            replacements: applicable,
            checkPendingArchiveRecovery: params.checkPendingArchiveRecovery,
            consumePendingReset: params.consumePendingReset,
            ownerAssignment: params.ownerAssignment,
            labelClaim: params.labelClaim,
            preparedTranscript: params.preparedTranscript,
            maintenance,
          };
          // Native harness rollback closures and process-held databases cannot cross isolates.
          if (!useWorker || hasPreparedNativeSessionDeletion()) {
            return withSqliteSessionDatabase(
              databaseOptions,
              (owned) =>
                withNativeSessionCommitContext(
                  owned,
                  resolved.env,
                  (source) => {
                    const committed = runOpenClawAgentWriteTransaction(
                      (database) => {
                        if (params.onLifecycleCommitted) {
                          deferOpenClawAgentPostCommitPublication(database, () =>
                            params.onLifecycleCommitted?.(result.pendingArchiveRecovery),
                          );
                        }
                        const result = commitSessionEntryReplacementsInDatabase(
                          database,
                          input,
                          () => {
                            assertCurrent();
                            source?.assertCurrent();
                          },
                        );
                        return {
                          ...result,
                          publish: prepareSessionIdentityPublication(
                            database,
                            resolved.agentId,
                            result.previous,
                            result.current,
                          ),
                        };
                      },
                      databaseOptions,
                      { operationLabel: "session.entry-replacements" },
                    );
                    committed.publish();
                    return {
                      maintenancePlans: committed.maintenancePlans,
                      result: operation.result,
                    };
                  },
                  params.afterCommitted
                    ? (source) => params.afterCommitted!(operation.result, source)
                    : undefined,
                ),
              assertCurrent,
            );
          }
          if (typeof snapshot.databaseIdentity !== "string") {
            throw new Error("Session replacement requires its durable database identity");
          }
          const committed = await commitSessionEntryReplacementsInWorker(
            databaseOptions,
            snapshot.databaseIdentity,
            input,
            assertCurrent,
            {
              identityAgentId: resolved.agentId,
              onLifecycleCommitted: params.onLifecycleCommitted,
              afterCommitted: params.afterCommitted
                ? (context) => params.afterCommitted!(operation.result, context)
                : undefined,
            },
            params.retainedExecution,
          );
          return { maintenancePlans: committed.maintenancePlans, result: operation.result };
        },
      };
    },
    "session.entry-replacements",
    params.withCommit,
    admission ? () => prepareSqliteScope(target) : undefined,
  );
  const committed = preparedWrite.result;
  await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    preparedWrite.scope,
    committed.maintenancePlans,
    { deletedEntriesBeforeMaintenance: preparedWrite.deletedEntries },
  );
  return committed.result;
}

export async function applySessionEntryExactReplacements<T>(params: {
  consumePendingReset?: boolean;
  assertCommitAllowed?: () => void;
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  skipMaintenance?: boolean;
  storePath: string;
  update: (
    entries: SessionEntryReplacementSnapshot[],
  ) => Promise<SessionEntryReplacementUpdate<T>> | SessionEntryReplacementUpdate<T>;
}): Promise<T> {
  return await applySqliteSessionEntryReplacementProjection(params, (replacements) =>
    [...(replacements ?? [])].map(({ entry, sessionKey }) => ({
      entry,
      sessionKey,
    })),
  );
}

/** Internal alias-aware owner; public SDK replacements remain exact-key only. */
export async function applySessionEntryCanonicalReplacements<T>(
  params: ReplacementProjectionParams<T, SessionEntryCanonicalReplacement>,
): Promise<T> {
  return await applySqliteSessionEntryReplacementProjection(
    {
      ...params,
      ...(params.sessionKeys
        ? {
            sessionKeys: uniqueStrings(params.sessionKeys.map((key) => key.trim()).filter(Boolean)),
          }
        : {}),
    },
    (replacements) =>
      [...(replacements ?? [])].map((replacement) => ({
        entry: replacement.entry,
        previousSessionKeys: uniqueStrings(
          replacement.previousSessionKeys.map((key) => key.trim()).filter(Boolean),
        ),
        sessionKey: replacement.sessionKey.trim(),
      })),
  );
}
