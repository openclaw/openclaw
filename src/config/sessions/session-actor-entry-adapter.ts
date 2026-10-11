import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { mergeSessionEntryPatch } from "./session-entry-patch-operation.js";
import type { SqliteSessionEntrySnapshotPatchParams } from "./session-entry-patch-source.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Async callbacks keep one compare-and-swap; closed reducers apply directly to current state. */
export async function patchSessionActorEntry(
  binding: SessionActorStorageBinding,
  params: Pick<SqliteSessionEntrySnapshotPatchParams, "update" | "options" | "sessionKey">,
) {
  const { actor, authority } = binding;
  const { options, update, sessionKey } = params;
  const source = await prepareSessionSourceAuthority(options.workerGuard?.source);
  const failures: unknown[] = [];
  let cancelled = false;
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
    const result = await actor.storage!.mutate(
      { type: "session.entry.patch", input: { ...input, operation: input.operation, expected } },
      {
        ...authority,
        authorize(stage, facts, publication) {
          authority.authorize(stage, facts, publication);
          if (options.shouldCommit?.() === false) {
            cancelled = true;
            throw new Error("Session entry mutation was cancelled");
          }
          if (isRecord(publication) && publication.kind === "session.entry.sources") {
            // SAFETY: The paired entry kernel emits this typed domain publication.
            acceptSessionSourceValidation(
              source,
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
    await releaseSessionSourceAuthorities([source], failures);
  }
}

/** The entry, label claim, transcript and owner assignment install in one actor command. */
export async function createSessionActorEntryWithTranscript<TError>(
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
