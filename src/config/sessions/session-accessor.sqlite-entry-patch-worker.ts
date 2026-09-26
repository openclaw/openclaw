import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  applySessionEntryPatchInDatabase,
  readSessionEntryPatchSnapshot,
  type SessionEntryPatchCommit,
  type SessionEntryPatchSelection,
} from "./session-accessor.sqlite-entry-mutation.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { prepareSessionIdentityPublication } from "./session-accessor.sqlite-identity.js";
import {
  createSessionEntryWorkerCommitPublication,
  rejectUnknownSessionEntryOutcome,
  withSessionEntryWorker,
} from "./session-accessor.sqlite-replacement-worker.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type PatchOutcome = { entry: SessionEntry | null; wrote: boolean };

/** One reservation owns snapshot preparation, mutation, and committed publication. */
export async function runSessionEntryPatch(params: {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  identityAgentId: string;
  capturedSource?: CapturedSessionEntryReadSource;
  selection: SessionEntryPatchSelection;
  operationLabel: SessionEntryPatchCommit["operationLabel"];
  prepare(snapshot: SqliteLifecycleTargetSnapshot): Promise<SessionEntryPatchCommit | undefined>;
  shouldCommit?: () => boolean;
  assertCommitAllowed?: () => void;
  onCommitted?: (entry: SessionEntry) => void;
}): Promise<PatchOutcome> {
  const { databaseOptions, capturedSource } = params;
  const assertSource = () => {
    if (capturedSource) {
      assertCapturedSessionEntryReadSource(
        capturedSource,
        getOpenClawAgentDatabaseIfOpen(databaseOptions),
      );
    }
  };
  if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
    // Process-held incognito and maintenance scopes cannot lend their connection to a worker.
    return runExclusiveSqliteSessionWrite(
      databaseOptions,
      async () =>
        withOpenClawAgentDatabaseAsync(
          databaseOptions,
          async () => {
            assertSource();
            const database = openOpenClawAgentDatabase(databaseOptions);
            const input = await params.prepare(
              readSessionEntryPatchSnapshot(database, params.selection),
            );
            if (!input || params.shouldCommit?.() === false) {
              return { entry: null, wrote: false };
            }
            const result = runOpenClawAgentWriteTransaction((current) => {
              assertSource();
              const mutation = applySessionEntryPatchInDatabase(current, input, () =>
                params.assertCommitAllowed?.(),
              );
              return {
                ...mutation,
                publish: mutation.identity
                  ? prepareSessionIdentityPublication(
                      current,
                      params.identityAgentId,
                      mutation.identity.previous,
                      mutation.identity.current,
                    )
                  : undefined,
              };
            }, databaseOptions);
            try {
              if (input.next) {
                params.onCommitted?.(result.entry);
              }
            } finally {
              result.publish?.();
            }
            return { entry: result.entry, wrote: result.identity !== undefined };
          },
          assertSource,
        ),
      params.operationLabel,
    );
  }

  const cancelled = new Error("Session patch cancelled before commit");
  let committing = false;
  let expectsPublication = false;
  let committedEntry: SessionEntry | undefined;
  let publication: ReturnType<typeof createSessionEntryWorkerCommitPublication> | undefined;
  return withSessionEntryWorker(
    databaseOptions,
    typeof capturedSource?.databaseIdentity === "string"
      ? capturedSource.databaseIdentity
      : undefined,
    () => {
      assertSource();
      if (committing) {
        if (params.shouldCommit?.() === false) {
          throw cancelled;
        }
        params.assertCommitAllowed?.();
      }
    },
    async (execution, source) => {
      const run = () =>
        execution.runExisting(source, async (worker): Promise<PatchOutcome> => {
          const snapshot = await worker.execute({
            type: "session.entry.patchSnapshot",
            input: params.selection,
          });
          const input = await params.prepare(snapshot);
          if (!input || params.shouldCommit?.() === false) {
            return { entry: null, wrote: false };
          }
          const identity = execution.fileIdentity;
          if (!identity) {
            throw new Error("Session patch lost its admitted database identity");
          }
          publication = createSessionEntryWorkerCommitPublication(
            databaseOptions,
            identity.physicalIdentity,
            params.identityAgentId,
          );
          expectsPublication = input.next !== undefined;
          committing = true;
          const outcome = await worker.execute({ type: "session.entry.patch", input }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          const unknown = await publication.settle(
            outcome.ok ? outcome.value.publication : undefined,
            () => {
              if (committedEntry) {
                params.onCommitted?.(committedEntry);
              }
            },
          );
          if (unknown) {
            rejectUnknownSessionEntryOutcome(
              "Session patch has no confirmed native completion and commit receipt",
              outcome.ok ? undefined : outcome.error,
            );
          }
          if (!outcome.ok) {
            if (outcome.error === cancelled) {
              return { entry: null, wrote: false };
            }
            throw outcome.error;
          }
          return { entry: outcome.value.entry, wrote: outcome.value.publication !== undefined };
        });
      let result = await run();
      if (!result) {
        await execution.prepare(source);
        result = await run();
      }
      if (!result) {
        throw new Error("Session patch lost its initialized database");
      }
      return result;
    },
    (admission, retained, facts) => {
      if (!expectsPublication) {
        return;
      }
      if (
        !isRecord(facts) ||
        !isRecord(facts.patchEntry) ||
        typeof facts.patchEntry.sessionId !== "string" ||
        typeof facts.patchEntry.updatedAt !== "number" ||
        !publication
      ) {
        throw new Error("Session patch commit omitted its persisted entry");
      }
      committedEntry = {
        ...facts.patchEntry,
        sessionId: facts.patchEntry.sessionId,
        updatedAt: facts.patchEntry.updatedAt,
      };
      publication.begin(admission, retained, facts);
    },
  );
}
