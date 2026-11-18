import path from "node:path";
import { iterateProjectedAgentRunSessionKeys } from "../../infra/agent-run-projection.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import { readDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { collectSessionControllerTargets } from "../../sessions/session-controller.lifecycle.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import type { SessionColdBatchInput } from "./session-accessor.sqlite-archive-types.js";
import { prepareSqliteColdArchiveBatch } from "./session-accessor.sqlite-archive.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type { SessionColdRestorationGuard } from "./session-cold-storage-guard.types.js";
import { runColdMutation } from "./session-cold-storage-mutation.js";
import type { SessionColdReadPreparation } from "./session-cold-storage-read.js";
import { prepareSessionColdStorageTargets } from "./session-cold-storage-targets.js";
import type {
  SessionColdBatchOptions,
  SessionColdBatchResult,
  SessionColdMaintenanceResult,
  SessionColdMutationResult,
  SessionColdSource,
} from "./session-cold-storage.types.js";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";
import { sessionStoreLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import {
  parseTranscriptAppendRefusal,
  SessionTranscriptWriterClaimReboundError,
} from "./session-transcript-writer-claim-error.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  resolveMaintenanceConfigFromInput,
  resolveSessionColdStorageConfig,
} from "./store-maintenance.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

const operations = new Map<string, StoreWriterQueue>();
const log = createSubsystemLogger("session-cold-storage");
const oversizedUntil = new Map<string, number>();
let nextStore = 0;
const restoredUntil = new Map<string, number>();
const RESTORE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPTS_PER_PASS = 128;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

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

async function archiveSessionColdBatch(
  options: SessionColdBatchOptions,
): Promise<SessionColdBatchResult> {
  const storePath = resolveOpenClawAgentSqlitePath(options.databaseOptions);
  const source = { readIdentity: options.readIdentity, readCustody: options.readCustody };
  const assertCurrent = () => options.assertCurrent?.();
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
      const input: SessionColdBatchInput & { source: SessionColdSource } = {
        source,
        databaseOptions: workerDatabaseOptions(options.databaseOptions),
        admissionIdentities: [
          ...(collectSessionControllerTargets(undefined, options.ownerStorePath).get(
            options.ownerStorePath,
          ) ?? []),
        ],
        liveSessionKeys: [...iterateProjectedAgentRunSessionKeys(buildProjectedAgentRunIndex())],
        cooledSessionIds: [...cooled],
        beforeMs: options.beforeMs,
        maxTranscripts: options.maxTranscripts,
        maxBytes: options.maxBytes,
      };
      const prepareBatch = () =>
        withSqliteMutationWorkerLifetime(
          input.databaseOptions,
          async ({ assertCurrent: assertRequestCurrent, signal }) => {
            const prepared = await prepareSqliteColdArchiveBatch(
              input,
              () => {
                assertRequestCurrent();
                assertCurrent();
              },
              signal,
            );
            assertRequestCurrent();
            assertCurrent();
            return prepared;
          },
        );
      let [batch] = await prepareBatch();
      if (batch?.needsReconcile) {
        await reconcileSessionTranscriptIndexes({ ...input.databaseOptions, assertCurrent });
        [batch] = await prepareBatch();
      }
      assertCurrent();
      if (!batch) {
        throw new Error("Cold archive worker returned no prepared batch");
      }
      for (const { sessionId, lowerBoundBytes } of batch.oversizedTranscripts) {
        oversizedUntil.set(`${storePath}\0${sessionId}`, Date.now() + RESTORE_COOLDOWN_MS);
        log.warn("Transcript remains in SQLite because one event exceeds the 64 MiB chunk limit", {
          agentId: input.databaseOptions.agentId,
          sessionId,
          lowerBoundBytes,
        });
      }
      const included = [
        ...batch.prepared.map((item) => item.plan.sessionId),
        ...batch.externalizations.map((item) => item.archive.session_id),
      ];
      const result = { archivedTranscripts: 0, externalizedTranscripts: 0 };
      for (const item of [
        ...batch.prepared.map((prepared) => ({ prepared: [prepared], externalizations: [] })),
        ...batch.externalizations.map((archive) => ({ prepared: [], externalizations: [archive] })),
      ]) {
        const committed = await runColdMutation(
          {
            kind: "cold-batch",
            databaseOptions: input.databaseOptions,
            prepared: item.prepared,
            externalizations: item.externalizations,
            beforeMs: options.beforeMs,
            protectionKeys: batch.protectionKeys,
            liveSessionKeys: input.liveSessionKeys,
          },
          source,
          () => {
            assertCurrent();
            const admissions = collectSessionControllerTargets(
              undefined,
              options.ownerStorePath,
            ).get(options.ownerStorePath);
            if (
              [
                ...(admissions ?? []),
                ...iterateProjectedAgentRunSessionKeys(buildProjectedAgentRunIndex()),
              ].some((identity) =>
                batch.protectionKeys.includes(normalizeStoreSessionKey(identity)),
              ) ||
              included.some(
                (id) =>
                  admissions?.has(id) ||
                  (restoredUntil.get(`${storePath}\0${id}`) ?? 0) > Date.now(),
              )
            ) {
              throw new Error("Transcript became active; cold archival was canceled");
            }
          },
        );
        result.archivedTranscripts += committed.archivedTranscripts;
        result.externalizedTranscripts += committed.externalizedTranscripts;
      }
      for (const sessionId of new Set([...included, ...batch.cleanupSessionIds])) {
        let afterSeq: number | undefined = -1;
        let maxRows = 256;
        while (true) {
          const swept = await runColdMutation(
            {
              kind: "cold-sweep",
              databaseOptions: input.databaseOptions,
              sessionId,
              afterSeq,
              maxRows,
            },
            source,
            assertCurrent,
          );
          const unit = swept.sweep!;
          if (unit.rows === 0) {
            if (afterSeq === undefined) {
              break;
            }
            afterSeq = undefined;
          } else {
            if (afterSeq !== undefined) {
              afterSeq = unit.afterSeq;
            }
            // A row ceiling bounds each admission; feedback leaves headroom below 50 ms.
            maxRows = Math.max(
              1,
              Math.min(256, Math.floor((unit.rows * 20) / Math.max(1, unit.elapsedMs))),
            );
          }
        }
      }
      if (included.length > 0 || batch.cleanupSessionIds.length > 0 || batch.freePages > 0) {
        await runColdMutation(
          { kind: "cold-maintain", databaseOptions: input.databaseOptions },
          source,
          assertCurrent,
        );
      }
      assertCurrent();
      return {
        archivedTranscripts: result.archivedTranscripts,
        externalizedTranscripts: result.externalizedTranscripts,
        envelopeBytes: batch.envelopeBytes,
        attemptedTranscripts: included.length + batch.oversizedTranscripts.length,
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
  const memory = captureSessionActorStorageOwner(
    {
      ...scope,
      storePath: scope.storePath ?? preparation?.target.path,
    },
    { assertCurrent: () => assertCurrent?.(), authorize: () => assertCurrent?.() },
  );
  if (memory) {
    memory.authority.assertCurrent();
    memory.binding?.actor.assertReadable();
    // Memory sessions have no archive, including sessions that were never created or already closed.
    return;
  }
  assertCurrent?.();
  if (!preparation) {
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
    const databasePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(target));
    target.path = databasePath;
    const options = toDatabaseOptions(target);
    const identity = await readDatabasePathIdentity(databasePath);
    assertPreparedCurrent();
    if (!identity.key.startsWith("file:")) {
      // First writers may create this store; there is no cold transcript to restore yet.
      return;
    }
    return await withSessionHistoryWorkerDatabase(
      {
        ...options,
        readIdentity: identity,
        readCustody: [
          {
            sourcePath: databasePath,
            candidates: [{ path: databasePath, physicalPath: identity.canonicalPath, identity }],
          },
        ],
      },
      async (owner) => {
        const assertAllowed = () => {
          assertPreparedCurrent();
          owner.assertCurrent();
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
              const current = await readDatabasePathIdentity(databasePath);
              assertAllowed();
              if (
                current.key !== identity.key ||
                current.canonicalPath !== identity.canonicalPath ||
                current.birthtime !== identity.birthtime
              ) {
                throw new Error(
                  "Session store changed while preparing its metadata. Retry the request.",
                );
              }
              return metadata;
            },
          },
          guard,
          signal,
        );
      },
      sessionStoreLane,
    );
  }
  const resolved = preparation.target;
  const options = toDatabaseOptions(resolved);
  const storePath = resolveOpenClawAgentSqlitePath(options);
  const key = `${storePath}\0${resolved.sessionId}`;
  const initial = await preparation.readMetadata("initial");
  signal?.throwIfAborted();
  assertCurrent?.();
  if (!initial.archive) {
    return;
  }
  await runQueuedStoreWrite({
    queues: operations,
    storePath,
    label: "session.cold.restore",
    signal,
    fn: async () => {
      assertCurrent?.();
      const metadata = await preparation.readMetadata("queued");
      signal?.throwIfAborted();
      assertCurrent?.();
      if (!metadata.archive) {
        return;
      }
      if (
        metadata.source.readIdentity.key !== initial.source.readIdentity.key ||
        metadata.source.readIdentity.birthtime !== initial.source.readIdentity.birthtime ||
        metadata.source.readIdentity.canonicalPath !== initial.source.readIdentity.canonicalPath
      ) {
        throw new Error("Cold transcript metadata changed its owning database while queued");
      }
      const result = await runColdMutation(
        {
          kind: "cold-restore",
          databaseOptions: workerDatabaseOptions(options),
          sessionId: resolved.sessionId,
          archive: metadata.archive,
          guard,
        },
        initial.source,
        assertCurrent,
        signal,
        preparation.acceptSourceValidation,
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

export async function runSessionColdStorageMaintenance(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  onProgress?: (progress: SessionColdMaintenanceResult) => void;
}): Promise<SessionColdMaintenanceResult> {
  const result: SessionColdMaintenanceResult = {
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  };
  const config = resolveSessionColdStorageConfig(params.config.session?.maintenance);
  const maintenance = resolveMaintenanceConfigFromInput(params.config.session?.maintenance);
  const retentionMs = maintenance.mode === "enforce" ? maintenance.resetArchiveRetentionMs : null;
  if (!config.enabled && retentionMs == null) {
    return result;
  }
  const nowMs = Date.now();
  const beforeMs = nowMs - config.afterDays * 24 * 60 * 60 * 1000;
  const { stores, assertCurrent } = await prepareSessionColdStorageTargets(
    params.config,
    params.assertCurrent,
  );
  assertCurrent();
  const start = stores.length ? nextStore % stores.length : 0;
  nextStore = start + 1;
  let remainingTranscripts = MAX_TRANSCRIPTS_PER_PASS;
  let remainingBytes = MAX_BATCH_BYTES;
  for (const { databaseOptions, ownerStorePath, readIdentity, readCustody } of [
    ...stores.slice(start),
    ...stores.slice(0, start),
  ]) {
    if (retentionMs != null) {
      const { prunePublishedSessionArchivesByRetention } =
        await import("./session-accessor.sqlite-archive-store.js");
      await prunePublishedSessionArchivesByRetention({
        scope: databaseOptions,
        source: { readIdentity, readCustody },
        rules: [
          { reason: "deleted", olderThanMs: retentionMs },
          { reason: "reset", olderThanMs: retentionMs },
        ],
        nowMs,
        assertCurrent,
      });
    }
    if (!config.enabled || remainingTranscripts <= 0 || remainingBytes <= 0) {
      continue;
    }
    assertCurrent();
    const batch = await archiveSessionColdBatch({
      databaseOptions,
      readIdentity,
      readCustody,
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
