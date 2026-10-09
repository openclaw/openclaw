import { statSync } from "node:fs";
import path from "node:path";
import { iterateProjectedAgentRunSessionKeys } from "../../infra/agent-run-projection.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { collectActiveSessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import { runSqliteTranscriptArchiveWorkerOperation } from "./session-accessor.sqlite-archive.js";
import type {
  SessionTranscriptReadScope,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import type { SessionColdRestorationGuard } from "./session-cold-storage-guard.types.js";
import type { SessionColdReadPreparation } from "./session-cold-storage-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type {
  SessionColdMutationPlan,
  SessionColdBatchPrepared,
  SessionColdPreparationWorkerData,
  SessionColdWorkerData,
} from "./session-cold-storage-worker.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import {
  projectionLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import {
  parseTranscriptAppendRefusal,
  SessionTranscriptWriterClaimReboundError,
} from "./session-transcript-writer-claim-error.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

const operations = new Map<string, StoreWriterQueue>();
const log = createSubsystemLogger("session-cold-storage");
const oversizedUntil = new Map<string, number>();
let nextStore = 0;
const restoredUntil = new Map<string, number>();
const RESTORE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPTS_PER_PASS = 128;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

export type SessionColdMaintenanceResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
};

function workerDatabaseOptions(options: OpenClawAgentDatabaseOptions) {
  const sourceEnv = options.env ?? process.env;
  return {
    agentId: options.agentId,
    path: resolveOpenClawAgentSqlitePath(options),
    env: {
      OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(
        options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv),
      ),
    },
  };
}

async function runColdMutation(
  plan: SessionColdMutationPlan,
  assertCurrent?: () => void,
  callerSignal?: AbortSignal,
  acceptSourceValidation?: SessionColdReadPreparation["acceptSourceValidation"],
): Promise<SessionColdMutationResult> {
  const sourceMatches =
    plan.kind === "cold-restore"
      ? plan.guard?.sources?.flatMap((source, index) =>
          source.conversationAlternatives
            ? [
                {
                  index,
                  matches: new Int32Array(
                    new SharedArrayBuffer(
                      (source.conversationAlternatives.length + 1) * Int32Array.BYTES_PER_ELEMENT,
                    ),
                  ),
                },
              ]
            : [],
        )
      : undefined;
  return await withSqliteMutationWorkerLifetime(
    plan.databaseOptions,
    async ({ assertCurrent: assertRequestCurrent, commitGate, signal }) => {
      const execution =
        plan.kind !== "cold-restore" && supportsOpenClawAgentDatabaseExecution(plan.databaseOptions)
          ? captureOpenClawAgentDatabaseExecution(plan.databaseOptions)
          : undefined;
      let retained: ReturnType<typeof retainOpenClawAgentDatabaseReadOnly> | undefined;
      try {
        const assertOpeningCurrent = () => {
          assertRequestCurrent();
          assertCurrent?.();
        };
        if (!execution) {
          retained = await runExclusiveSqliteSessionWrite(
            plan.databaseOptions,
            async () => {
              assertOpeningCurrent();
              return retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
            },
            "session.reclamation.retain",
            undefined,
            "foreground",
            signal,
          );
        }
        const executionClaim = execution
          ? await withSessionEntryWorker(
              plan.databaseOptions,
              undefined,
              assertOpeningCurrent,
              (owner, source) =>
                owner.runExisting(source, async () => owner.captureGenerationClaim()),
              undefined,
              execution,
              signal,
            )
          : undefined;
        const claim = executionClaim ?? (retained?.found ? retained.claim : undefined);
        if (!claim) {
          throw new Error("Cold transcript operation lost its owning database");
        }
        const assertAllowed = () => {
          claim.assertCurrent();
          assertRequestCurrent();
          assertCurrent?.();
        };
        const diagnostics: SqliteSessionReclamationDiagnostics = { kind: plan.kind };
        const [completed] = await withSqliteReclamationAuthorization(
          commitGate,
          retained?.found ? retained.database.db : plan.databaseOptions.path,
          () => {
            if (sourceMatches?.length) {
              if (!acceptSourceValidation) {
                throw new Error("Cold restoration requires source validation acceptance");
              }
              const validation: SessionSourceValidation = {
                conversationMatches: sourceMatches.map(({ index, matches }) => {
                  if (Atomics.load(matches, 0) !== 1) {
                    throw new Error("Cold restoration source alternatives are not ready");
                  }
                  return {
                    index,
                    alternatives: Array.from(
                      { length: matches.length - 1 },
                      (_, alternative) => alternative,
                    ).filter((alternative) => Atomics.load(matches, alternative + 1) === 1),
                  };
                }),
              };
              acceptSourceValidation(validation);
              assertAllowed();
              for (const match of validation.conversationMatches) {
                const matches = sourceMatches.find(({ index }) => index === match.index)!.matches;
                const accepted = match.acceptedAlternatives ?? match.alternatives;
                for (let alternative = 0; alternative < matches.length - 1; alternative++) {
                  Atomics.store(matches, alternative + 1, accepted.includes(alternative) ? 1 : 0);
                }
              }
              return;
            }
            assertAllowed();
          },
          (authorize) =>
            runSqliteTranscriptArchiveWorkerOperation<{
              result: SessionColdMutationResult;
              cleanupIncomplete?: boolean;
            }>({
              diagnostics,
              signal,
              expectedMessageType: "reclaimed",
              validationOwner: executionClaim
                ? { source: plan.databaseOptions, claim: executionClaim }
                : retained?.found
                  ? { database: retained.database, isCurrent: retained.claim.isCurrent }
                  : undefined,
              onCommitRequest: authorize,
              withWriteAdmission: async (run, reclamationAdmission) =>
                runExclusiveSqliteSessionWrite(
                  plan.databaseOptions,
                  async () => {
                    let refusal: { error: unknown } | undefined;
                    try {
                      assertAllowed();
                    } catch (error) {
                      refusal = { error };
                    }
                    await run(refusal);
                  },
                  "session.reclamation.worker-commit",
                  { ...diagnostics, reclamationAdmission },
                  "worker",
                  signal,
                ),
              workerData: {
                type: "sqlite-transcript-archive-v2",
                operation: "cold-mutate",
                plan,
                commitGate,
                sourceMatches,
              } satisfies SessionColdWorkerData,
            }),
        );
        if (!completed || completed.cleanupIncomplete) {
          throw new Error(
            "Cold transcript worker cleanup is incomplete; restart OpenClaw before another maintenance operation",
          );
        }
        if (plan.kind !== "cold-restore") {
          await withSqliteSessionPageReclamation(plan.databaseOptions, (reclaimPages) =>
            reclaimSqliteFreePages(plan.databaseOptions, undefined, {
              reclaimPages,
              maxPages: 64 * 512,
              assertCurrent: assertAllowed,
            }),
          );
        }
        if (
          plan.kind === "cold-restore" &&
          completed.result.restored &&
          completed.result.sessionKey !== undefined &&
          retained?.found &&
          retained.claim.isCurrent()
        ) {
          assertAllowed();
          // Restoration commits transcript rows only; a facts-less change would revoke sharing.
          sessionChanges.emit({
            storePath: retained.database.path,
            sessionKey: completed.result.sessionKey,
            facts: { kind: "unchanged" },
          });
        }
        return completed.result;
      } finally {
        await execution?.release();
        if (retained?.found) {
          retained.claim.release();
        }
      }
    },
    callerSignal,
  );
}

type ColdBatchOptions = {
  databaseOptions: OpenClawAgentDatabaseOptions;
  ownerStorePath: string;
  beforeMs: number;
  maxTranscripts: number;
  maxBytes: number;
  assertCurrent?: () => void;
};

type ColdBatchResult = SessionColdMaintenanceResult & {
  envelopeBytes: number;
  attemptedTranscripts: number;
};

async function archiveSessionColdBatch(options: ColdBatchOptions): Promise<ColdBatchResult> {
  const storePath = resolveOpenClawAgentSqlitePath(options.databaseOptions);
  const source = createOpenClawAgentDatabasePathMatcher();
  source(storePath, storePath);
  const assertCurrent = () => {
    options.assertCurrent?.();
    if (!source.isCurrent()) {
      throw new Error("Cold transcript database changed during maintenance");
    }
  };
  return runQueuedStoreWrite({
    queues: operations,
    storePath,
    label: "session.cold.archive",
    fn: async () => {
      assertCurrent();
      const cooled = new Set<string>();
      const now = Date.now();
      for (const cache of [restoredUntil, oversizedUntil]) {
        for (const [key, until] of cache) {
          if (until <= now) {
            cache.delete(key);
          } else if (key.startsWith(`${storePath}\0`)) {
            cooled.add(key.slice(storePath.length + 1));
          }
        }
      }
      const input: SessionColdPreparationWorkerData["input"] = {
        databaseOptions: workerDatabaseOptions(options.databaseOptions),
        admissionIdentities: [
          ...(collectActiveSessionWorkAdmissions().get(options.ownerStorePath) ?? []),
        ],
        liveSessionKeys: [...iterateProjectedAgentRunSessionKeys(buildProjectedAgentRunIndex())],
        cooledSessionIds: [...cooled],
        beforeMs: options.beforeMs,
        maxTranscripts: options.maxTranscripts,
        maxBytes: options.maxBytes,
      };
      const [batch] = await withSqliteMutationWorkerLifetime(
        input.databaseOptions,
        async ({ assertCurrent: assertRequestCurrent, signal }) => {
          const prepared =
            await runSqliteTranscriptArchiveWorkerOperation<SessionColdBatchPrepared>({
              expectedMessageType: "done",
              signal,
              assertCurrent: () => {
                assertRequestCurrent();
                assertCurrent();
              },
              workerData: {
                type: "sqlite-transcript-archive-v2",
                operation: "cold-prepare",
                input,
              } satisfies SessionColdPreparationWorkerData,
            });
          assertRequestCurrent();
          assertCurrent();
          return prepared;
        },
      );
      assertCurrent();
      if (!batch) {
        throw new Error("Cold archive worker returned no prepared batch");
      }
      const empty: ColdBatchResult = {
        archivedTranscripts: 0,
        externalizedTranscripts: 0,
        envelopeBytes: 0,
        attemptedTranscripts: 0,
      };
      for (const sessionId of batch.oversizedSessionIds) {
        oversizedUntil.set(`${storePath}\0${sessionId}`, Date.now() + RESTORE_COOLDOWN_MS);
        log.warn("Transcript remains in SQLite because its archive exceeds the 64 MiB limit", {
          agentId: input.databaseOptions.agentId,
        });
      }
      const included = [
        ...batch.prepared.map((item) => item.plan.sessionId),
        ...batch.externalizations.map((item) => item.archive.session_id),
      ];
      const result =
        included.length > 0
          ? await runColdMutation(
              {
                kind: "cold-batch",
                databaseOptions: input.databaseOptions,
                prepared: batch.prepared,
                externalizations: batch.externalizations,
                beforeMs: options.beforeMs,
                protectionKeys: batch.protectionKeys,
                liveSessionKeys: input.liveSessionKeys,
              },
              () => {
                assertCurrent();
                const admissions = collectActiveSessionWorkAdmissions().get(options.ownerStorePath);
                if (
                  [
                    ...(admissions ?? []),
                    ...iterateProjectedAgentRunSessionKeys(buildProjectedAgentRunIndex()),
                  ].some((identity) =>
                    batch.protectionKeys.includes(normalizeStoreSessionKey(identity)),
                  )
                ) {
                  throw new Error("Transcript became active; cold archival was canceled");
                }
                if (
                  included.some(
                    (id) =>
                      admissions?.has(id) ||
                      (restoredUntil.get(`${storePath}\0${id}`) ?? 0) > Date.now(),
                  )
                ) {
                  throw new Error("Transcript became active; cold archival was canceled");
                }
              },
            )
          : batch.freePages > 0
            ? await runColdMutation(
                { kind: "cold-maintain", databaseOptions: input.databaseOptions },
                assertCurrent,
              )
            : empty;
      assertCurrent();
      return {
        archivedTranscripts: result.archivedTranscripts,
        externalizedTranscripts: result.externalizedTranscripts,
        envelopeBytes: batch.envelopeBytes,
        attemptedTranscripts: included.length + batch.oversizedSessionIds.length,
      };
    },
  });
}

export class SessionColdTurnReboundError extends Error {
  constructor(readonly result: NonNullable<SessionColdMutationResult["turnRebound"]>) {
    super("Session changed before cold transcript restoration");
    this.name = "SessionColdTurnReboundError";
  }
}

export class SessionColdSourceReboundError extends Error {
  constructor(readonly refusal: NonNullable<SessionColdMutationResult["refusedSource"]>) {
    super("Session source changed before cold transcript restoration");
    this.name = "SessionColdSourceReboundError";
  }
}

export async function restoreSessionColdTranscript(
  scope: SessionTranscriptReadScope,
  assertCurrent?: () => void,
  preparation?: SessionColdReadPreparation,
  guard?: SessionColdRestorationGuard,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  assertCurrent?.();
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    binding.admissionSignal?.throwIfAborted();
    binding.actor.assertReadable();
    // An actor has no cold archive to restore; loss must still reject this continuation.
    return;
  }
  let resolved = preparation?.target;
  if (
    !resolved &&
    (isIncognitoSessionKey(scope.sessionKey) ||
      (scope.agentId &&
        scope.storePath &&
        isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
          agentId: scope.agentId,
          env: scope.env,
        })))
  ) {
    resolved = resolveSqliteTranscriptReadScope(scope);
  }
  if (!resolved) {
    const captured = {
      ...scope,
      ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
      env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
    };
    const context = captureOpenClawStateReadWorkerContext({ env: captured.env });
    const assertPreparedCurrent = () => {
      signal?.throwIfAborted();
      context.maintenanceScope?.assertAdmission();
      context.admission.assertCurrent();
      assertCurrent?.();
    };
    const target = await prepareSqliteTranscriptReadScope(captured, signal);
    assertPreparedCurrent();
    target.path = resolveOpenClawAgentSqlitePath(toDatabaseOptions(target));
    resolved = target;
    const options = toDatabaseOptions(target);
    if (!isIncognitoOpenClawAgentSqlitePath(target.path, options)) {
      // Synchronous inspection stays within the admission check above.
      try {
        statSync(target.path);
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        // First writers may create this store; there is no cold transcript to restore yet.
        return;
      }
      const source = createOpenClawAgentDatabasePathMatcher();
      source(target.path, target.path);
      return await withSessionHistoryWorkerDatabase(
        options,
        async (owner) => {
          const assertAllowed = () => {
            assertPreparedCurrent();
            owner.assertCurrent();
            if (!source.isCurrent()) {
              throw new Error(
                "Session store changed while preparing its metadata. Retry the request.",
              );
            }
          };
          return await restoreSessionColdTranscript(
            captured,
            assertAllowed,
            {
              target,
              readMetadata: async () => {
                const metadata = await owner.readColdMetadata(
                  {
                    sessionId: target.sessionId,
                    env: captured.env,
                  },
                  signal,
                );
                return metadata.archive;
              },
            },
            guard,
            signal,
          );
        },
        projectionLane,
      );
    }
  }
  const options = toDatabaseOptions(resolved);
  const storePath = resolveOpenClawAgentSqlitePath(options);
  const key = `${storePath}\0${resolved.sessionId}`;
  const readNativeMetadata = () => {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionColdTranscript(database.db, resolved.sessionId),
      options,
    );
    return result.found ? result.value : undefined;
  };
  // Incognito retains its process-held database; durable readers always supply preparation.
  const initial = preparation ? await preparation.readMetadata("initial") : readNativeMetadata();
  if (preparation) {
    signal?.throwIfAborted();
    assertCurrent?.();
  }
  if (!initial) {
    return;
  }
  await runQueuedStoreWrite({
    queues: operations,
    storePath,
    label: "session.cold.restore",
    signal,
    fn: async () => {
      assertCurrent?.();
      const archive = preparation ? await preparation.readMetadata("queued") : readNativeMetadata();
      if (preparation) {
        signal?.throwIfAborted();
        assertCurrent?.();
      }
      if (!archive) {
        return;
      }
      const result = await runColdMutation(
        {
          kind: "cold-restore",
          databaseOptions: workerDatabaseOptions(options),
          sessionId: resolved.sessionId,
          archive,
          guard,
        },
        assertCurrent,
        signal,
        preparation?.acceptSourceValidation,
      );
      if (result.turnRebound) {
        throw new SessionColdTurnReboundError(result.turnRebound);
      }
      if (result.refusedSource) {
        throw new SessionColdSourceReboundError(result.refusedSource);
      }
      if (result.writerRefusal !== undefined) {
        const refusal = parseTranscriptAppendRefusal(result.writerRefusal);
        if (!refusal) {
          throw new Error("Cold transcript writer refusal has an invalid identity");
        }
        throw new SessionTranscriptWriterClaimReboundError(refusal);
      }
      signal?.throwIfAborted();
      assertCurrent?.();
      // Keep viewed history hot without changing canonical transcript timestamps or bytes.
      const now = Date.now();
      for (const [id, until] of restoredUntil) {
        if (until <= now) {
          restoredUntil.delete(id);
        }
      }
      restoredUntil.set(key, now + RESTORE_COOLDOWN_MS);
    },
  });
}

async function configuredStores(config: OpenClawConfig, assertCallerCurrent?: () => void) {
  const prepared = prepareSessionStoreTargetInventory(
    config,
    listConfiguredSessionStoreAgentIds(config),
    process.env,
    "configured",
  );
  const { env, candidates } = prepared;
  const context = captureOpenClawStateReadWorkerContext({ env });
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  const source = createOpenClawAgentDatabasePathMatcher();
  for (const candidate of candidates) {
    source(candidate.path, candidate.path);
  }
  const assertCurrent = () => {
    assertCallerCurrent?.();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    if (!source.isCurrent()) {
      throw new Error("Session store changed during cold maintenance");
    }
  };
  const stores = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const registry = await registryRead.read();
    assertCurrent();
    registryRead.assertCurrent();
    discovery.assertCurrent();
    const inventory = await discovery.readTargetInventory({
      ...prepared,
      registeredDatabases:
        registry.result.status === "available"
          ? registry.result.entries
          : { status: "unavailable" },
    });
    assertCurrent();
    registryRead.assertCurrent();
    discovery.assertCurrent();
    if (inventory.kind === "session-target-registry-required") {
      throw new Error("Cold maintenance did not receive its registry snapshot");
    }
    return inventory.agents.flatMap(({ result, reads }) =>
      result.available
        ? result.targets.map((target, index) => ({
            databaseOptions: {
              ...reads[index]!.database,
              // Archive paths and restore cooldowns retain the configured SQLite locator.
              path: reads[index]!.target.storePath,
              env,
            },
            ownerStorePath: target.storePath,
          }))
        : [],
    );
  });
  assertCurrent();
  registryRead.assertCurrent();
  return { stores, assertCurrent };
}

export async function runSessionColdStorageMaintenance(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  onProgress?: (progress: SessionColdMaintenanceResult) => void;
}): Promise<SessionColdMaintenanceResult> {
  const result: SessionColdMaintenanceResult = {
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  };
  const config = params.config.session?.maintenance?.coldStorage;
  if (!config?.enabled) {
    return result;
  }
  const beforeMs = Date.now() - (config.afterDays ?? 30) * 24 * 60 * 60 * 1000;
  const { stores, assertCurrent } = await configuredStores(params.config, params.assertCurrent);
  assertCurrent();
  const start = stores.length ? nextStore % stores.length : 0;
  nextStore = start + 1;
  let remainingTranscripts = MAX_TRANSCRIPTS_PER_PASS;
  let remainingBytes = MAX_BATCH_BYTES;
  for (const { databaseOptions, ownerStorePath } of [
    ...stores.slice(start),
    ...stores.slice(0, start),
  ]) {
    if (remainingTranscripts <= 0 || remainingBytes <= 0) {
      break;
    }
    assertCurrent();
    const batch = await archiveSessionColdBatch({
      databaseOptions,
      ownerStorePath,
      beforeMs,
      maxTranscripts: remainingTranscripts,
      maxBytes: remainingBytes,
      assertCurrent,
    });
    assertCurrent();
    result.archivedTranscripts += batch.archivedTranscripts;
    result.externalizedTranscripts += batch.externalizedTranscripts;
    remainingTranscripts -= batch.attemptedTranscripts;
    remainingBytes -= batch.envelopeBytes;
    params.onProgress?.({ ...result });
  }
  return result;
}
