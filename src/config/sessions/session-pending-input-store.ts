import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionInputLifecycleAdmission } from "./restart-resume.js";
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
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { buildRestartRecoveryExpectedState } from "./session-transcript-turn-state.js";
import {
  settleSessionWorkerReceipt,
  type SessionWorkerReceiptAdmission,
} from "./session-worker-receipt.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type PendingInputScope = SessionAccessScope & {
  sessionActor?: import("./session-actor-storage-binding.js").SessionActorStorageBinding;
  agentId: string;
  sessionId: string;
};

export async function preparePendingInputStore(
  scope: PendingInputScope,
  assertCurrent: () => void,
  lifecycleAdmission?: SessionInputLifecycleAdmission,
) {
  const memoryOwner = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  if (lifecycleAdmission && memoryOwner) {
    throw new Error("Restart resume requires a durable session.");
  }
  if (memoryOwner) {
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
  if (lifecycleAdmission && !inputActor) {
    throw new Error("Restart resume requires the current input actor.");
  }
  const logical = resolveSqliteScope({ ...captured, storePath: undefined });
  const target = captureSessionStoreReadTarget(
    captured,
    "Pending input changed its captured database owner",
  );
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
  const readTarget = target.resolve(resolved);
  const identity = readTarget.identity;
  if (!identity.key.startsWith("file:")) {
    throw new Error("Pending input changed its captured database owner");
  }
  const assertSource = readTarget.assertCurrent;
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
    input: Extract<PendingInputMutation, { kind: "complete" }>,
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
    async withAdmission<T>(operation: () => Promise<T>, reentrant: boolean): Promise<T> {
      let entered = false;
      const run = () =>
        runOpenClawAgentWriteAdmission(
          options,
          () => {
            entered = true;
            return operation();
          },
          reentrant,
        );
      try {
        return await run();
      } catch (error) {
        if (!entered) {
          unregister();
        }
        throw error;
      }
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
    // Released SDK completion retains immediate transaction semantics; stage/finish use workers.
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
            let expectedState: ReturnType<typeof buildRestartRecoveryExpectedState> | undefined;
            let receipt: ReturnType<typeof readPendingInputMutationReceipt>;
            const outcome = await runSessionActorCommand(
              inputActor.actor,
              authority,
              async (snapshot) => {
                const hot = snapshot ?? (await inputActor.actor.read(authority));
                if (!hot.entry) {
                  throw new Error("Input actor lost its staged session");
                }
                // Select lifecycle facts inside the FIFO, then retain them across version rebasing.
                const resume = input.expected.existing ? undefined : lifecycleAdmission;
                expectedState ??=
                  resume?.expectedState ?? buildRestartRecoveryExpectedState(hot.entry);
                return inputActor.actor.acceptInput(
                  {
                    commandId: randomUUID(),
                    phaseId: `accept:${input.runId}`,
                    expected: hot.version,
                    pending: input,
                    lifecycle: resume?.lifecycle ?? {},
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
                );
              },
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
          let admitted: SessionWorkerReceiptAdmission | undefined;
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
            async (execution, source) => {
              const result = await execution.runExisting(source, async (worker) => {
                const receipt = await settleSessionWorkerReceipt(
                  () => worker.execute({ type: "session.pendingInputs.mutate", input }),
                  () => admitted,
                  readReceipt,
                  "Pending input has no confirmed native completion and commit receipt",
                  "Pending input native commitment is unknown; do not replay",
                );
                if (publish) {
                  assertOpen();
                  publish(committedFacts, assertOpen);
                }
                return receipt;
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
