import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  getOpenClawAgentDatabaseIfOpen,
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
import { runSessionActorCommand } from "./session-actor-scope.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
} from "./session-actor-storage-binding.js";
import { getSessionInputActor, throwSessionInputActorFailure } from "./session-input-actor.js";
import { prepareMemoryPendingInputStore } from "./session-pending-input-memory-store.js";
import {
  readPendingInputMutationReceipt,
  type PendingInputCustodyGrant,
  type PendingInputMutation,
  type PendingInputRead,
} from "./session-pending-input-operations.types.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type PendingInputScope = SessionAccessScope & {
  sessionActor?: import("./session-actor-storage-binding.js").SessionActorStorageBinding;
  agentId: string;
  sessionId: string;
};

export async function preparePendingInputStore(
  scope: PendingInputScope,
  assertCurrent: () => void,
) {
  if (captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent })) {
    const acquired = await acquireSessionActorStorage(scope, {
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      authority: { assertCurrent, authorize: assertCurrent },
    });
    if (!acquired) {
      throw new Error("Pending input session was closed or removed");
    }
    return prepareMemoryPendingInputStore(acquired, assertCurrent, () => acquired.actor.release());
  }
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const inputActor = await getSessionInputActor(scope);
  const logical = resolveSqliteScope({ ...captured, storePath: undefined });
  const storePath =
    logical.path ??
    captured.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const inputSource = inputActor?.target.readSource;
  const resolved = inputSource
    ? resolveSqliteScope(captured, undefined, {
        agentId: inputSource.agentId,
        path: inputSource.path,
        shared: inputSource.agentId !== logical.agentId,
      })
    : await prepareSqliteScope(captured);
  assertCurrent();
  const options = {
    ...toDatabaseOptions(resolved),
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
  };
  if (
    inputActor &&
    (inputActor.target.readSource?.path !== options.path ||
      inputActor.target.readSource.agentId !== options.agentId)
  ) {
    throw new Error("Input actor changed the pending input's physical target");
  }
  const identity = identities.get(assertSessionStoreReadCandidate(options.path, candidates));
  if (!identity || !identity.key.startsWith("file:")) {
    throw new Error("Pending input changed its captured database owner");
  }
  const assertSource = () => {
    if (identity) {
      assertSessionStoreReadCandidate(options.path, candidates);
      assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
    }
  };
  const { mutatePendingInput } = await import("./session-pending-input-operations.kernel.js");
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
    sessionActor: undefined,
    assertCurrent: assertOpen,
    withAdmission<T>(operation: () => Promise<T>, reentrant: boolean): Promise<T> {
      let entered = false;
      const run = () =>
        runOpenClawAgentWriteAdmission(
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
      return run();
    },
    sessionKey: resolved.sessionKey,
    databaseAgentId: options.agentId ?? resolved.agentId,
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
          if (inputActor && input.kind === "stage") {
            const authority = { assertCurrent, authorize: assertCurrent };
            const hot =
              inputActor.actor.snapshot(authority) ?? (await inputActor.actor.read(authority));
            if (hot.entry?.sessionId !== input.sessionId) {
              return { kind: "stage" as const, current: false };
            }
            if (
              hot.transcript.modelContext.kind === "resident" &&
              !hot.pendingInputs.some((row) => row.idempotency_key === input.idempotencyKey) &&
              !hot.completionKeys.includes(input.idempotencyKey) &&
              !hot.transcript.idempotency.some((row) => row.key === input.idempotencyKey)
            ) {
              return {
                kind: "stage" as const,
                current: true,
                existing: undefined,
                previous: undefined,
                committed: undefined,
              };
            }
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
      publish?: (
        facts: PendingInputCustodyGrant | undefined,
        assertSourceCurrent: () => void,
      ) => void,
    ) {
      return track(
        (async () => {
          assertOpen();
          if (inputActor && input.kind === "stage") {
            let committedFacts: PendingInputCustodyGrant | undefined;
            let authorityFailure: unknown;
            const authority = {
              assertCurrent: assertOpen,
              authorize(stage: "transaction" | "commit", _hot: unknown, publication?: unknown) {
                try {
                  if (
                    isRecord(publication) &&
                    publication.kind === "pending-input-settlement-custody"
                  ) {
                    // SAFETY: The actor delegates the same pending-input kernel and grant.
                    committedFacts = publication as PendingInputCustodyGrant;
                    guard(stage, committedFacts);
                  }
                  assertOpen();
                } catch (error) {
                  authorityFailure = error;
                  throw error;
                }
              },
            };
            const hot =
              inputActor.actor.snapshot(authority) ?? (await inputActor.actor.read(authority));
            if (!hot.entry) {
              throw new Error("Input actor lost its staged session");
            }
            const expectedState = buildRestartRecoveryExpectedState(hot.entry);
            let receipt: ReturnType<typeof readPendingInputMutationReceipt>;
            const outcome = await runSessionActorCommand(inputActor.actor, authority, (snapshot) =>
              inputActor.actor.acceptInput(
                {
                  commandId: randomUUID(),
                  phaseId: `accept:${input.runId}`,
                  expected: snapshot?.version ?? hot.version,
                  pending: input,
                  lifecycle: {},
                  expectedState,
                },
                authority,
                {
                  committed(commit) {
                    receipt = readPendingInputMutationReceipt(
                      commit.value.pendingInputReceipt,
                      input,
                    );
                    if (!receipt) {
                      throw new Error("Input actor omitted its committed custody receipt");
                    }
                    publish?.(committedFacts, assertOpen);
                  },
                },
              ),
            );
            if (outcome.kind !== "committed") {
              throwSessionInputActorFailure(outcome, authorityFailure);
            }
            if (outcome.failure && outcome.failure.origin !== "response") {
              throw Object.assign(new Error(outcome.failure.message), {
                name: outcome.failure.name,
              });
            }
            if (!receipt) {
              throw new Error("Input actor omitted its native completion receipt");
            }
            return receipt;
          }
          let admitted:
            | {
                admission: SqliteWorkerOperationAdmission;
                retained: RetainedWorkerTransactionAdmission;
              }
            | undefined;
          const readReceipt = (facts: unknown) => readPendingInputMutationReceipt(facts, input);
          let committedFacts: PendingInputCustodyGrant | undefined;
          const checkGrant = (stage: "transaction" | "commit", facts: unknown) => {
            if (
              !isRecord(facts) ||
              !isRecord(facts.publication) ||
              facts.publication.kind !== "pending-input-settlement-custody"
            ) {
              return;
            }
            // SAFETY: The paired kernel sends bounded row facts, never host authority.
            committedFacts = facts.publication as PendingInputCustodyGrant;
            guard(stage, committedFacts);
          };
          return withSessionEntryWorker(
            options,
            identity?.key.slice(5),
            assertOpen,
            async (execution, source, context) => {
              const result = await execution.runExisting(source, async (worker) => {
                const native = getOpenClawAgentDatabaseIfOpen(options);
                const revision = native && readSqliteNativeMutationRevision(native.db);
                const assertPublicationCurrent = () => {
                  context.assertCurrent();
                  if (
                    getOpenClawAgentDatabaseIfOpen(options) !== native ||
                    (native &&
                      (native.db.isTransaction ||
                        revision === undefined ||
                        readSqliteNativeMutationRevision(native.db) !== revision))
                  ) {
                    throw new Error("Pending input authority changed before publication");
                  }
                };
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
                    if (publish) {
                      assertPublicationCurrent();
                      publish(committedFacts, assertPublicationCurrent);
                    }
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
