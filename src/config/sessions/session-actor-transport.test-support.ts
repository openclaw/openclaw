import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  settleSqliteWorkerOperationContext,
  type SqliteWorkerOperationContext,
  type SqliteWorkerOperationSettlement,
} from "../../infra/sqlite-worker-operation-settlement.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { SessionActorOperations } from "./session-actor-contract.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import {
  seedSessionActorOutcomeTransferEntry,
  sessionActorFileTarget,
} from "./session-actor-worker.test-support.js";
import { createSessionActor, type SessionActorTransport } from "./session-actor.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

type Fault = {
  reply: "normal" | "lost" | "unknown" | "unknown-result";
  beforeAdmissionError?: Error;
  replyError?: Error;
  transactionError?: Error;
  settlementLost?: boolean;
  settlementError?: Error;
  workerPublicationFailure?: boolean;
  incompleteOutcomeTransfer?: boolean;
  afterCommitted?: () => Promise<void>;
  drain?: Promise<void>;
  onExecuted?: () => void;
  admissionCancelled?: boolean;
  disclosureRevoked?: boolean;
};

/** Real transaction kernels and native receipts with publication and transport faults. */
function createFixture() {
  const fixture = createSessionCompoundWorkerFixture();
  const { database } = fixture;
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const target = sessionActorFileTarget(database, fixture.scope.sessionKey);
  const options = { agentId: "main", path: database.path };
  const commands: string[] = [];
  const admissions: SqliteWorkerAdmissionRequest[] = [];
  const fault: Fault = { reply: "normal" };
  let epoch = 0;
  const lifetime = {
    assertAdmission() {
      if (fault.admissionCancelled) {
        throw new Error("Admission cancelled");
      }
    },
    assertCurrent() {},
    assertReadable() {
      if (fault.disclosureRevoked) {
        throw new Error("Snapshot disclosure revoked");
      }
    },
  };
  const replica = createSessionActorReplica({
    target,
    lifetime,
    currentGeneration: () => `fixture:${epoch}`,
  });
  let admit: AgentWorkerOperationContext["admit"] = () => {
    throw new Error("No active transport admission");
  };
  const createKernel = () =>
    createSessionActorWorker(
      {
        options,
        open: () => database,
        admit: (stage, publication, transferList) => admit(stage, publication, transferList),
        writeTransaction: (_label, _owner, write) => {
          const result = runOpenClawAgentWriteTransaction((db) => {
            const value = write(db);
            if (fault.transactionError) {
              throw fault.transactionError;
            }
            return value;
          }, options);
          if (fault.workerPublicationFailure) {
            throw new Error("Worker publication failed");
          }
          return result;
        },
      },
      () => target.database,
    );
  let kernel = createKernel();
  const transport: SessionActorTransport = {
    run(operation, authorize) {
      return runOpenClawAgentWorkerWrite(options, async () => {
        async function execute<Key extends keyof SessionActorOperations>(command: {
          type: Key;
          input: SessionActorOperations[Key]["input"];
        }): Promise<SessionActorOperations[Key]["output"]>;
        async function execute(
          command: SqliteWorkerCommand<SessionActorOperations>,
        ): Promise<SessionActorOperations[keyof SessionActorOperations]["output"]> {
          let admittedOutcomeDataFrames = 0;
          let interruptedOutcomeTransferFrame = false;
          commands.push(command.type);
          if (fault.beforeAdmissionError) {
            throw fault.beforeAdmissionError;
          }
          const completion = Promise.withResolvers<SqliteWorkerOperationSettlement>();
          const retained = { settled: completion.promise };
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            admissions.push(request);
            authorize(request, { admission, retained }, grant);
          });
          const dropped = fault.reply === "unknown" || fault.reply === "unknown-result";
          const postMessage = admission.port.postMessage.bind(admission.port);
          const wire = vi
            .spyOn(admission.port, "postMessage")
            .mockImplementation((message, transferList) => {
              if (
                isRecord(message) &&
                ((dropped &&
                  (message.kind === "native-commit" || message.kind === "native-settlement")) ||
                  (fault.settlementLost && message.kind === "native-settlement"))
              ) {
                return;
              }
              postMessage(message, transferList);
              // Native admission blocks synchronously; its host runs on this fixture's isolate.
              admission.service();
            });
          const native: SqliteWorkerOperationContext = { port: admission.port };
          admit = (stage, publication, transferList) => {
            const actorPublication =
              isRecord(publication) && isRecord(publication.publication)
                ? publication.publication
                : undefined;
            if (
              fault.incompleteOutcomeTransfer &&
              !interruptedOutcomeTransferFrame &&
              stage === "transaction" &&
              isRecord(actorPublication) &&
              actorPublication.kind === "session-actor-outcome" &&
              isRecord(actorPublication.transfer)
            ) {
              if (admittedOutcomeDataFrames > 0) {
                interruptedOutcomeTransferFrame = true;
                throw new Error("Synthetic incomplete actor outcome transfer");
              }
              admittedOutcomeDataFrames += 1;
            }
            requestSqliteWorkerOperationAdmission(
              { stage, facts: { identity, publication } },
              transferList,
            );
          };
          try {
            await kernel.prepare(command);
            const value = withSqliteWorkerOperationAdmission(native, () => kernel.execute(command));
            const finish = () => {
              settleSqliteWorkerOperationContext(native, "completed");
              admission.service();
              completion.resolve(
                dropped || fault.settlementLost
                  ? {
                      kind: "unknown",
                      error: fault.settlementError ?? new Error("Native receipt lost"),
                    }
                  : { kind: "completed" },
              );
            };
            if (fault.drain) {
              void fault.drain.then(finish);
            } else {
              finish();
            }
            fault.onExecuted?.();
            if (fault.reply !== "normal") {
              const error = fault.replyError ?? new Error("Ordinary reply lost");
              if (fault.reply === "unknown-result" && command.type !== "session.actor.read") {
                return {
                  kind: "unknown",
                  target,
                  commandId: command.input.commandId,
                  error: { name: error.name, message: error.message },
                };
              }
              throw error;
            }
            return value;
          } finally {
            void completion.promise.then(() => {
              wire.mockRestore();
              admission.finish();
            });
          }
        }
        return operation({ execute });
      });
    },
    async afterCommitted(outcome) {
      if (fault.afterCommitted) {
        await fault.afterCommitted();
        const copy = structuredClone(outcome);
        copy.receipt.commandId = "detached-follow-up-copy";
        return { value: copy.value };
      }
      return undefined;
    },
    async release() {},
  };
  const actor = createSessionActor({ target, lifetime, replica, transport });
  return {
    value: {
      actor,
      admissions,
      commands,
      fault,
      seedTransferEntry: () => seedSessionActorOutcomeTransferEntry(fixture),
      readEntry: fixture.read,
      retireGeneration(this: void) {
        epoch += 1;
        kernel.close();
        kernel = createKernel();
      },
      nativePatch(this: void, updatedAt: number) {
        runOpenClawAgentWriteTransaction(
          (db) =>
            writeSessionEntry(db, fixture.scope.sessionKey, {
              ...fixture.read()!,
              updatedAt,
            }),
          options,
        );
      },
    },
    async close() {
      await actor.release();
      kernel.close();
    },
  };
}

export async function withActor(
  run: (fixture: ReturnType<typeof createFixture>["value"]) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    try {
      await run(fixture.value);
    } finally {
      await fixture.close();
    }
  });
}
