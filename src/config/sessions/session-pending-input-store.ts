import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
} from "./session-pending-input-operations.types.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export async function preparePendingInputStore(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  assertCurrent: () => void,
) {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const incognito = isIncognitoSessionKey(captured.sessionKey);
  const logical = resolveSqliteScope({ ...captured, storePath: undefined });
  const storePath =
    logical.path ??
    captured.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = incognito ? [] : captureSessionStoreReadCandidates(storePath);
  const identities = new Map(
    candidates
      .filter((candidate) => !candidate.scope)
      .map((candidate) => {
        const identity = readDatabasePathIdentitySync(candidate.path);
        return [identity.canonicalPath, identity] as const;
      }),
  );
  const resolved = await prepareSqliteScope(captured);
  assertCurrent();
  const options = {
    ...toDatabaseOptions(resolved),
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  };
  const identity = incognito
    ? undefined
    : identities.get(assertSessionStoreReadCandidate(options.path, candidates));
  if (!incognito && (!identity || !identity.key.startsWith("file:"))) {
    throw new Error("Pending input changed its captured database owner");
  }
  const assertSource = () => {
    if (identity) {
      assertSessionStoreReadCandidate(options.path, candidates);
      assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
    }
  };
  const { readPendingInputStage, mutatePendingInput } =
    await import("./session-pending-input-operations.kernel.js");
  assertSource();
  let revoked = false;
  let revokeCustody = () => {};
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const drain = async () => {
    while (pending.size) {
      await Promise.allSettled(pending);
    }
  };
  const settled = async () => {
    await drain();
    if (failures.length) {
      throw failures[0];
    }
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource({
    agentId: options.agentId ?? resolved.agentId,
    path: options.path,
    revoke() {
      revoked = true;
      revokeCustody();
    },
    close: drain,
  });
  const assertOpen = () => {
    if (revoked) {
      throw new Error("Pending input database owner has closed");
    }
    assertSource();
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      (error: unknown) => {
        failures.push(error);
        pending.delete(operation);
      },
    );
    return operation;
  };
  const nativeMutation = (
    input: PendingInputMutation,
    guard: (stage: "transaction" | "commit", facts?: PendingInputCustodyGrant) => void,
  ) => {
    assertOpen();
    return mutatePendingInput(
      input,
      {
        admit: (stage, facts) => {
          assertOpen();
          // SAFETY: The shared kernel supplies this same custody grant for native and worker calls.
          guard(stage, facts as PendingInputCustodyGrant | undefined);
        },
        writeTransaction: (operationLabel, _owner, run) =>
          runOpenClawAgentWriteTransaction(run, options, { operationLabel }),
      },
      () => {},
    );
  };
  return {
    assertCurrent: assertOpen,
    withAdmission<T>(operation: () => Promise<T>, reentrant: boolean): Promise<T> {
      let entered = false;
      return runOpenClawAgentWriteAdmission(
        options,
        () => {
          entered = true;
          return operation();
        },
        reentrant,
      ).catch((error: unknown) => {
        if (!entered) {
          unregister();
        }
        throw error;
      });
    },
    sessionKey: resolved.sessionKey,
    path: options.path,
    workerDatabasePath: identity?.canonicalPath ?? options.path,
    bindCustody(revoke: () => void) {
      revokeCustody = revoke;
    },
    settled,
    retire(operation: Promise<void>) {
      void track(operation);
      void operation.then(unregister, (error: unknown) => {
        if (!hasSqliteWorkerOutcomeUnknown(error)) {
          unregister();
        }
      });
    },
    async release() {
      try {
        await settled();
      } finally {
        unregister();
      }
    },
    read(input: PendingInputRead) {
      return track(
        (async () => {
          assertOpen();
          assertCurrent();
          if (incognito) {
            return readPendingInputStage(openOpenClawAgentDatabase(options), input);
          }
          return withSessionEntryWorker(
            options,
            identity?.key.slice(5),
            () => {
              assertOpen();
              assertCurrent();
            },
            async (execution, source) => {
              const result = await execution.runExisting(source, (worker) =>
                worker.execute({ type: "session.pendingInputs.read", input }),
              );
              if (!result) {
                throw new Error("Pending input lost its existing database");
              }
              return result;
            },
          );
        })(),
      );
    },
    // Released synchronous recorder completion keeps its native visibility contract.
    nativeMutation,
    mutate(
      input: PendingInputMutation,
      guard: (stage: "transaction" | "commit", facts?: PendingInputCustodyGrant) => void,
      publish?: () => void,
    ) {
      return track(
        (async () => {
          assertOpen();
          if (incognito) {
            const result = nativeMutation(input, guard);
            publish?.();
            return result;
          }
          let admitted:
            | {
                admission: SqliteWorkerOperationAdmission;
                retained: RetainedWorkerTransactionAdmission;
              }
            | undefined;
          const readReceipt = (facts: unknown): PendingInputMutationReceipt | undefined => {
            if (
              !isRecord(facts) ||
              facts.kind !== "pending-input-settlement" ||
              facts.operation !== input.kind ||
              facts.sessionKey !== input.sessionKey ||
              facts.sessionId !== input.sessionId ||
              facts.idempotencyKey !== input.idempotencyKey ||
              facts.runId !== input.runId ||
              facts.requestHash !== input.requestHash ||
              facts.lifecycleGeneration !== input.lifecycleGeneration
            ) {
              return undefined;
            }
            // SAFETY: The exact paired kernel and admission own this tagged native receipt.
            return facts as PendingInputMutationReceipt;
          };
          const checkGrant = (stage: "transaction" | "commit", facts: unknown) => {
            if (
              !isRecord(facts) ||
              !isRecord(facts.publication) ||
              facts.publication.kind !== "pending-input-settlement-custody"
            ) {
              return;
            }
            // SAFETY: The paired kernel sends bounded row facts, never host authority.
            guard(stage, facts.publication as PendingInputCustodyGrant);
          };
          return withSessionEntryWorker(
            options,
            identity?.key.slice(5),
            assertOpen,
            async (execution, source) => {
              const result = await execution.runExisting(source, async (worker) => {
                const outcome = await worker
                  .execute({ type: "session.pendingInputs.mutate", input })
                  .then(
                    (value) => ({ ok: true as const, value }),
                    (error: unknown) => ({ ok: false as const, error }),
                  );
                if (admitted) {
                  await admitted.retained.settled;
                  const receipt = readReceipt(admitted.admission.committed?.facts);
                  if (admitted.admission.settlement?.kind === "completed" && receipt) {
                    if (publish) {
                      assertOpen();
                    }
                    publish?.();
                    return receipt;
                  }
                  if (admitted.admission.settlement?.kind !== "completed") {
                    throw new SqliteWorkerError(
                      "Pending input native commitment is unknown; do not replay",
                      "outcome-unknown",
                    );
                  }
                }
                if (!outcome.ok) {
                  throw outcome.error;
                }
                throw new SqliteWorkerError(
                  "Pending input has no confirmed native completion and commit receipt",
                  "outcome-unknown",
                );
              });
              if (!result) {
                throw new Error("Pending input lost its existing database");
              }
              return result;
            },
            (admission, retained, facts) => {
              checkGrant("commit", facts);
              if (
                !isRecord(facts) ||
                !isRecord(facts.publication) ||
                !readReceipt(facts.publication.receipt)
              ) {
                throw new Error("Pending input commit omitted its exact receipt");
              }
              admitted = { admission, retained };
            },
            undefined,
            undefined,
            undefined,
            (facts) => checkGrant("transaction", facts),
          );
        })(),
      );
    },
  };
}
