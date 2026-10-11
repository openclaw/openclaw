import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import type {
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptResult,
} from "./session-accessor.types.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
  type SessionActorStorageScope,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { mergeSessionEntryPatch } from "./session-entry-patch-operation.js";
import type { SqliteSessionEntrySnapshotPatchParams } from "./session-entry-patch-source.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import { prepareSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Entry writes may create a memory owner only when their patch provides a creation fallback. */
export async function patchSessionActorEntryInScope(
  scope: SessionActorStorageScope,
  params: Pick<SqliteSessionEntrySnapshotPatchParams, "update" | "options" | "sessionKey">,
): Promise<{ entry: SessionEntry | null } | undefined> {
  const selected = getSessionActorStorageBinding(scope);
  if (selected) {
    return { entry: await patchSessionActorEntry(selected, params) };
  }
  const authority = { assertCurrent() {}, authorize() {} };
  if (!captureSessionActorStorageOwner(scope, authority)) {
    return undefined;
  }
  const binding = await acquireSessionActorStorage(scope, {
    authority,
    lifetime: { assertCurrent() {}, assertReadable() {} },
    create: Boolean(params.options.fallbackEntry),
  });
  if (!binding) {
    return { entry: null };
  }
  try {
    return {
      entry: await patchSessionActorEntry(binding, {
        ...params,
        sessionKey: binding.actor.target.sessionKey,
      }),
    };
  } finally {
    await binding.actor.release();
  }
}

/** Async callbacks keep one compare-and-swap; closed reducers apply directly to current state. */
async function patchSessionActorEntry(
  binding: SessionActorStorageBinding,
  params: Pick<SqliteSessionEntrySnapshotPatchParams, "update" | "options" | "sessionKey">,
) {
  const { actor, authority } = binding;
  const { options, update, sessionKey } = params;
  const source = await prepareSessionSourceAuthority(options.workerGuard?.source);
  const failures: unknown[] = [];
  let cancelled = false;
  let maintenancePreservation:
    | Awaited<ReturnType<typeof prepareSessionMaintenancePreservation>>
    | undefined;
  try {
    const input = {
      operation: typeof update === "function" ? undefined : update,
      fallbackEntry: options.fallbackEntry,
      preserveActivity: options.preserveActivity,
      replaceEntry: options.replaceEntry,
      consumePendingReset: options.consumePendingReset,
      providerReviewMutation: options.providerReviewMutation,
      prepareIf: options.prepareIf,
      guards: {
        shouldCommitIf: options.workerGuard?.shouldCommitIf,
        cliHistory: options.workerGuard?.cliHistory,
        conversation: options.workerGuard?.conversation,
        sources: source.checks.map(({ predicate }) => predicate),
      },
    };
    let expected: { entry: SessionEntry | undefined } | undefined;
    if (typeof update === "function") {
      const entry = await actor.storage!.read({ type: "session.entry.read", input: {} }, authority);
      if (options.prepareIf && !entry?.liveModelSwitchPending) {
        return null;
      }
      const writeBase = entry ?? options.fallbackEntry;
      if (!writeBase) {
        return null;
      }
      const patch = await update(structuredClone(writeBase), {
        existingEntry: structuredClone(entry),
      });
      const next = mergeSessionEntryPatch({
        ...options,
        existing: entry,
        writeBase,
        patch,
        sessionKey,
      });
      if (!next) {
        return entry ?? null;
      }
      expected = { entry };
      input.operation = { kind: "fields", patch: next };
      input.replaceEntry = true;
    }
    if (!input.operation) {
      throw new Error("Session actor patch omitted its operation");
    }
    const config = options.skipMaintenance
      ? undefined
      : (options.maintenanceConfig ?? resolveMaintenanceConfig());
    if (config && config.mode !== "warn") {
      maintenancePreservation = await prepareSessionMaintenancePreservation(binding.path);
    }
    const result = await actor.storage!.mutate(
      {
        type: "session.entry.patch",
        input: {
          ...input,
          operation: input.operation,
          expected,
          ...(config && maintenancePreservation
            ? { maintenance: { config, preservation: maintenancePreservation.capture() } }
            : {}),
        },
      },
      {
        ...authority,
        authorize(stage, facts, publication) {
          authority.authorize(stage, facts, publication);
          if (options.shouldCommit?.() === false) {
            cancelled = true;
            throw new Error("Session entry mutation was cancelled");
          }
          if (isRecord(publication) && publication.kind === "session.entry.sources") {
            acceptSessionSourceValidation(
              source,
              // SAFETY: The entry guard publishes its typed validateSources result under this kind.
              publication.validation as SessionSourceValidation,
            );
          }
        },
        assertCurrent() {
          authority.assertCurrent();
          source.assertCurrent();
          options.workerGuard?.assertCurrent?.();
          options.workerGuard?.assertMutationAllowed?.();
          options.assertCommitAllowed?.();
        },
      },
      {
        committed(outcome) {
          const change = outcome.changes.find((value) => value.sessionKey === sessionKey);
          if (!outcome.value || isDeepStrictEqual(change?.before?.entry, change?.after?.entry)) {
            return;
          }
          const predicate = options.workerGuard?.shouldCommitIf;
          options.onCommitted?.(
            outcome.value,
            predicate && change?.before?.entry?.sessionId === outcome.value.sessionId
              ? { sessionId: predicate.sessionId, watermark: change.before.transcript.watermark }
              : undefined,
          );
          const database = actor.target.database;
          if (database.kind !== "memory") {
            throw new Error("Memory patch lost its owner");
          }
          options.onCommittedSource?.(
            {
              agentId: binding.agentId,
              path: binding.path,
              databaseIdentity: database.incarnation,
            },
            outcome.value,
          );
        },
      },
    );
    return cancelled && result.kind === "rolled-back"
      ? null
      : (readSessionActorStorageResult(result) ?? null);
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    maintenancePreservation?.dispose();
    await releaseSessionSourceAuthorities([source], failures);
  }
}

/** Creation selects the memory namespace before any durable database preparation. */
export async function createSessionActorEntryWithTranscriptInScope<TError>(
  scope: SessionActorStorageScope,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
): Promise<SessionEntryCreateWithTranscriptResult<TError> | undefined> {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  const binding = await acquireSessionActorStorage(scope, {
    authority: { assertCurrent, authorize: assertCurrent },
    lifetime: { assertCurrent, assertReadable: assertCurrent },
    create: true,
  });
  if (!binding) {
    return undefined;
  }
  try {
    const env = { ...scope.env, OPENCLAW_STATE_DIR: path.resolve(binding.path, "../../../..") };
    return await createSessionActorEntryWithTranscript(binding, env, createEntry, options);
  } finally {
    await binding.actor.release();
  }
}

/** The entry, label claim, transcript and owner assignment install in one actor command. */
async function createSessionActorEntryWithTranscript<TError>(
  binding: SessionActorStorageBinding,
  env: NodeJS.ProcessEnv,
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const { actor, authority } = binding;
  const database = actor.target.database;
  if (database.kind !== "memory") {
    throw new Error("Session creation requires a memory actor");
  }
  const prepared = await actor.storage!.read(
    { type: "session.entry.creation", input: { label: options.label } },
    authority,
  );
  return withSessionEntryCreationPublication(
    {
      agentId: binding.agentId,
      sessionKey: actor.target.sessionKey,
      bind: options.bindCreation,
      file: {
        kind: "actor",
        path: binding.path,
        agentId: binding.agentId,
        databaseIdentity: database.incarnation,
        assertCurrent: () => actor.assertCurrent(),
      },
    },
    async (publication) => {
      options.onPhase?.("entry");
      const created = await createEntry(prepared);
      if (!created.ok) {
        return { ok: false, error: created.error, phase: "entry" };
      }
      const commit = async (assertSourceCurrent?: () => void) => {
        options.onPhase?.("commit");
        const entry = readSessionActorStorageResult(
          await actor.storage!.mutate(
            {
              type: "session.entry.create",
              input: {
                entry: created.entry,
                expected: prepared.targetEntry,
                label: options.label,
                cwd: options.cwd,
                transcriptEvents: created.transcriptEvents,
                owner: options.resolveOwnerAssignment?.(),
              },
            },
            {
              ...authority,
              assertCurrent() {
                authority.assertCurrent();
                options.commitGuard?.();
                assertSourceCurrent?.();
              },
            },
            { committed: ({ value }) => options.onLifecycleCommitted?.(value) },
          ),
        );
        if (options.afterCommitted) {
          const handle = await actor.storage!.acquire(actor.target.sessionKey);
          try {
            await options.afterCommitted(entry, {
              env,
              assertCurrent() {
                handle.assertCurrent();
                authority.assertCurrent();
              },
            });
          } finally {
            await handle.release();
          }
        }
        return { ok: true as const, entry, sessionFile: actor.target.sessionKey };
      };
      return options.withCommit
        ? options.withCommit((assertSourceCurrent) =>
            runWithSessionEntryCreationPublication(publication, () => commit(assertSourceCurrent)),
          )
        : commit();
    },
  );
}
