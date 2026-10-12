import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { deferOpenClawAgentPostCommitPublication } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { withNativeSessionCommitContext } from "./session-accessor.sqlite-commit-context.js";
import type {
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
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
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryCommitContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryReplacement,
} from "./session-accessor.types.js";
import {
  captureIncognitoSessionOperation,
  publishIncognitoSessionEntry,
  withIncognitoSessionActor,
} from "./session-incognito-binding.js";
import { maintenanceLane, projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "./session-transcript-worker.types.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
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
  includeSessionWindowOwner?: string;
  includeLabelOwners?: string;
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

type CreationProjection = {
  scope: ResolvedSqliteScope & { path: string; env: NodeJS.ProcessEnv };
  sessionKey: string;
  initializeTranscript?: { sessionKey: string; sessionId: string; cwd?: string };
  onWriterAdmitted?: () => void;
};

async function applySqliteSessionEntryReplacementProjection<T, TReplacement>(
  params: ReplacementProjectionParams<T, TReplacement>,
  normalize: (replacements: Iterable<TReplacement> | undefined) => SqliteSessionEntryReplacement[],
  creation?: CreationProjection,
  retainedIncognito?: ReturnType<typeof captureIncognitoSessionOperation>,
): Promise<T> {
  const target = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.activeSessionKey ?? params.sessionKeys?.[0] ?? "",
    storePath: params.storePath,
    env: params.env,
  };
  const incognito = retainedIncognito ?? captureIncognitoSessionOperation(target);
  const env = cloneEnvWithPlatformSemantics(
    params.env ??
      (incognito
        ? { OPENCLAW_STATE_DIR: path.resolve(incognito.actor.path, "../../../..") }
        : process.env),
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  target.env = env;
  if (incognito && !retainedIncognito) {
    return withIncognitoSessionActor(
      incognito.actor,
      () =>
        applySqliteSessionEntryReplacementProjection(
          { ...params, env },
          normalize,
          creation,
          incognito,
        ),
      incognito.admissionSignal,
    );
  }
  const admission =
    !incognito && !creation && isMainThread ? resolveSqliteWriteAdmissionScope(target) : undefined;
  const scope =
    creation?.scope ??
    admission ??
    (isMainThread && !incognito ? await prepareSqliteScope(target) : resolveSqliteScope(target));
  scope.path ??= resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const preparedWrite = await runPreparedSqliteSessionWrite(
    scope,
    async (preparedScope) => {
      creation?.onWriterAdmitted?.();
      if (creation) {
        params.assertCommitAllowed?.();
      }
      const resolved = { ...preparedScope, env };
      const databaseOptions = {
        ...toDatabaseOptions(resolved),
        path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
      };
      const useWorker =
        creation !== undefined ||
        (isMainThread && supportsOpenClawAgentDatabaseExecution(databaseOptions));
      const readNative = () =>
        withSqliteSessionDatabase(databaseOptions, (database) => ({
          ...readSessionEntryReplacementState(database, params),
          databaseIdentity: readOpenClawAgentDatabaseIdentity(database).identity,
        }));
      const snapshot = incognito
        ? {
            ...(await incognito.actor.sessions.entry(
              {
                assertCurrent() {
                  incognito.authority.assertCurrent();
                  params.assertCommitAllowed?.();
                },
              },
              {
                type: "session.entry.replacements.prepare",
                input: {
                  sessionKeys: params.sessionKeys,
                  includeSessionWindowOwner: params.includeSessionWindowOwner,
                  includeLabelOwners: params.includeLabelOwners,
                },
              },
              incognito.admissionSignal,
            )),
            databaseIdentity: incognito.actor.identity.incarnation,
          }
        : useWorker
          ? await withSessionHistoryWorkerDatabase(
              databaseOptions,
              async (owner) => {
                const read = () =>
                  owner.readExactEntries({
                    sessionKeys: params.sessionKeys ?? [],
                    projection: "replacement",
                    replacementSelection: {
                      sessionKeys: params.sessionKeys,
                      includeSessionWindowOwner: params.includeSessionWindowOwner,
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
              },
              // Label owners can expand a keyed selection beyond the foreground read budget.
              params.sessionKeys &&
                params.sessionKeys.length + (params.includeSessionWindowOwner ? 1 : 0) <=
                  MAX_SESSION_ROW_FACTS_KEYS &&
                params.includeLabelOwners === undefined
                ? projectionLane
                : maintenanceLane,
            )
          : await readNative();
      const { entries, expectedRows, labelOwnerKeys } = snapshot;
      const selectedKeys = snapshot.selectedSessionKeys
        ? new Set(snapshot.selectedSessionKeys)
        : undefined;
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
          if (selectedKeys && !selectedKeys.has(sessionKey)) {
            throw new Error(
              `Session entry replacement is outside the selected key set: ${sessionKey}`,
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
          replacement.previousSessionKeys ||
          expectedRows.has(replacement.sessionKey) ||
          creation?.sessionKey === replacement.sessionKey,
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
          // Native companions and process-held stores retain their synchronous transaction view.
          const workerCommit =
            Boolean(incognito) || (useWorker && !hasPreparedNativeSessionDeletion());
          const preparedPreservation =
            params.skipMaintenance === false
              ? await prepareSessionMaintenancePreservation(params.storePath, {
                  native: !workerCommit,
                })
              : undefined;
          try {
            const maintenance = preparedPreservation
              ? {
                  activeSessionKey: params.activeSessionKey ?? "",
                  archiveDirectory: resolveSqliteTranscriptArchiveDirectory(resolved),
                  maintenance: resolveMaintenanceConfig(),
                  preservation: preparedPreservation.capture(),
                  storePath: params.storePath,
                }
              : undefined;
            const assertCurrent = () => {
              assertSourceCurrent?.();
              params.assertCommitAllowed?.();
              if (
                maintenance &&
                !isDeepStrictEqual(maintenance.preservation, preparedPreservation?.capture())
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
            if (incognito) {
              const actor = incognito.actor;
              const committed = await actor.sessions.entry(
                {
                  assertCurrent() {
                    incognito.authority.assertCurrent();
                    assertCurrent();
                  },
                },
                { type: "session.entry.replacements.commit", input },
                undefined,
                (result) => {
                  try {
                    params.onLifecycleCommitted?.(result.pendingArchiveRecovery);
                  } finally {
                    for (const key of new Set([
                      ...result.previous.keys(),
                      ...result.current.keys(),
                    ])) {
                      publishIncognitoSessionEntry(
                        actor,
                        key,
                        result.previous.get(key),
                        result.current.get(key),
                      );
                    }
                  }
                },
              );
              let active = true;
              try {
                await params.afterCommitted?.(operation.result, {
                  env,
                  assertCurrent() {
                    if (!active) {
                      throw new Error("Session commit owner is no longer current");
                    }
                    incognito.authority.assertCurrent();
                    assertCurrent();
                  },
                });
              } finally {
                active = false;
              }
              return { maintenancePlans: committed.maintenancePlans, result: operation.result };
            }
            if (!workerCommit) {
              return await withSqliteSessionDatabase(
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
                            preparedPreservation?.refreshCandidates,
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
              { ...input, initializeTranscript: creation?.initializeTranscript },
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
          } finally {
            preparedPreservation?.dispose();
          }
        },
      };
    },
    "session.entry-replacements",
    params.withCommit,
    admission ? () => prepareSqliteScope(target) : undefined,
    incognito ? "worker" : "foreground",
  );
  const committed = preparedWrite.result;
  await finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
    preparedWrite.scope,
    committed.maintenancePlans,
    { deletedEntriesBeforeMaintenance: preparedWrite.deletedEntries },
  );
  return committed.result;
}

/** Worker creation admits an absent exact target; public replacement selection stays unchanged. */
export async function applySessionEntryCreationReplacement(
  params: ReplacementProjectionOptions &
    CreationProjection & {
      entry: SessionEntryReplacement["entry"];
      previousSessionKeys: readonly string[];
      afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    },
): Promise<void> {
  await applySqliteSessionEntryReplacementProjection(
    {
      ...params,
      sessionKeys: [params.sessionKey, ...params.previousSessionKeys],
      afterCommitted: params.afterCommitted
        ? (_result, context) => params.afterCommitted!(context)
        : undefined,
      update: () => ({
        result: undefined,
        replacements: [
          {
            sessionKey: params.sessionKey,
            entry: params.entry,
            ...(params.previousSessionKeys.length
              ? { previousSessionKeys: params.previousSessionKeys }
              : {}),
          },
        ],
      }),
    },
    (replacements) => [...(replacements ?? [])],
    params,
  );
}

export async function applySessionEntryExactReplacements<T>(params: {
  consumePendingReset?: boolean;
  assertCommitAllowed?: () => void;
  activeSessionKey?: string;
  agentId?: string;
  requireWriteSuccess?: boolean;
  sessionKeys?: readonly string[];
  includeSessionWindowOwner?: string;
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
