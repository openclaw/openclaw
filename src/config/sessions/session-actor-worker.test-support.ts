import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  type SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerTransferCollector } from "../../infra/sqlite-worker-transfer.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type {
  SessionActorHotState,
  SessionActorTarget,
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseResults,
} from "./session-actor-contract.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";
import { commitSessionLifecycleProjection } from "./session-lifecycle-projection.worker.js";
import type { SessionParticipantRecordInput } from "./session-sharing-store.types.js";
import { bindSqliteWorkerBackend as bindSharingBackend } from "./session-sharing-store.worker.js";

type Command = SqliteWorkerCommand<SessionActorOperations>;
export type Mutation = Exclude<Command, { type: "session.actor.read" }>;

export const SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT = 1_024;

export function seedSessionActorOutcomeTransferTranscript(
  fixture: Pick<ReturnType<typeof createSessionCompoundWorkerFixture>, "database" | "scope">,
): void {
  // Unique keys alone exceed the limit even when serialization deduplicates strings.
  const keyPayload = "k".repeat(
    Math.ceil(SQLITE_WORKER_MAX_MESSAGE_BYTES / SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT),
  );
  const events = Array.from({ length: SESSION_ACTOR_TRANSFER_TEST_MESSAGE_COUNT }, (_, index) => ({
    type: "message",
    id: `bounded-message-${String(index).padStart(5, "0")}`,
    parentId: index === 0 ? null : `bounded-message-${String(index - 1).padStart(5, "0")}`,
    timestamp: "2026-01-01T00:00:01Z",
    message: {
      role: "user",
      content: "Synthetic retained transcript identity for receipt transport coverage.",
      idempotencyKey: `${String(index).padStart(5, "0")}:${keyPayload}`,
    },
  }));
  runSqliteImmediateTransactionSync(fixture.database.db, () =>
    appendTranscriptEventsInTransaction(fixture.database, fixture.scope, events),
  );
}

function createFixture() {
  const seed = createSessionCompoundWorkerFixture();
  let database = seed.database;
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "string") {
    throw new Error("Actor worker fixture requires a durable database");
  }
  const target: SessionActorTarget = {
    sessionKey: seed.scope.sessionKey,
    database: {
      kind: "file",
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: database.path,
    },
  };
  const hooks: {
    admit?: AgentWorkerOperationContext["admit"];
    withCommit?: (commit: () => void) => void;
    afterTransaction?: () => void;
    transactionOptions?: SqliteTransactionOptions;
    transactions: number;
  } = { transactions: 0 };
  let commitFacts: unknown;
  let transferredOutcome: unknown;
  let outcomeTransfer: ReturnType<typeof createSqliteWorkerTransferCollector> | undefined;
  let lastReply: SessionActorOperations["session.actor.patch"]["output"] | undefined;
  const context: AgentWorkerOperationContext = {
    open: () => database,
    options: { agentId: "main", path: database.path },
    admit(stage, facts) {
      hooks.admit?.(stage, facts);
      if (
        isRecord(facts) &&
        isRecord(facts.publication) &&
        facts.publication.kind === "session-actor-outcome"
      ) {
        outcomeTransfer?.accept(facts.publication.transfer);
      }
    },
    writeTransaction(operationLabel, _owner, write, diagnosticContext) {
      hooks.transactions += 1;
      const result = runSqliteImmediateTransactionSync(database.db, () => write(database), {
        ...hooks.transactionOptions,
        operationLabel,
        diagnosticContext,
        withCommit: (commit) => (hooks.withCommit ? hooks.withCommit(commit) : commit()),
      });
      hooks.afterTransaction?.();
      return result;
    },
  };
  let actor = createSessionActorWorker(context, () => target.database);
  const { port1, port2 } = new MessageChannel();
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    grant();
  });
  const receipts: unknown[] = [];
  const postMessage = port1.postMessage.bind(port1);
  const wire = vi.spyOn(port1, "postMessage").mockImplementation((message, transferList) => {
    postMessage(message, transferList);
    const received: unknown = receiveMessageOnPort(port2)?.message;
    if (!isRecord(received)) {
      throw new Error("Synchronous actor fixture lost its native frame");
    }
    if (received.kind === "native-commit" || received.kind === "native-settlement") {
      receipts.push(received);
      if (received.kind === "native-commit" && isRecord(received.committed)) {
        commitFacts = received.committed.facts;
      }
      return;
    }
    // Preserve real admission exchanges while their native caller blocks on this isolate.
    admission.port.postMessage(
      received,
      received.port instanceof MessagePort ? [received.port] : [],
    );
    admission.service();
  });
  const execute = (command: Command) =>
    withSqliteWorkerOperationAdmission({ port: port1 }, () => actor.execute(command));
  return {
    target,
    scope: { ...seed.scope, path: database.path },
    hooks,
    get database() {
      return database;
    },
    read(selected = target): SessionActorHotState {
      const value = execute({ type: "session.actor.read", input: { target: selected } });
      if ("kind" in value) {
        throw new Error("Actor read returned a mutation outcome");
      }
      return value;
    },
    mutate(command: Mutation): SessionActorOutcome<SessionActorPhaseResults[SessionActorPhase]> {
      commitFacts = undefined;
      transferredOutcome = undefined;
      outcomeTransfer = createSqliteWorkerTransferCollector("outcome", (value) => {
        transferredOutcome = value;
      });
      const value = execute(command);
      if (!("kind" in value)) {
        throw new Error("Actor mutation returned a read snapshot");
      }
      lastReply = value;
      if (value.kind !== "committed") {
        return value;
      }
      const evidence =
        isRecord(commitFacts) && commitFacts.kind === "session-actor-committed-transfer"
          ? outcomeTransfer.completed && outcomeTransfer.id === commitFacts.transferId
            ? transferredOutcome
            : undefined
          : commitFacts;
      if (!isRecord(evidence) || evidence.kind !== "committed") {
        throw new Error("Actor acknowledgement has no native committed outcome");
      }
      // The worker's native receipt is the typed outcome; the command reply carries only failure.
      const committed = evidence as Extract<
        SessionActorOutcome<SessionActorPhaseResults[SessionActorPhase]>,
        { kind: "committed" }
      >;
      return value.failure ? { ...committed, failure: value.failure } : committed;
    },
    reply: () => lastReply,
    participant(params: SessionParticipantRecordInput) {
      const backend = bindSharingBackend(undefined, {
        database: database.db,
        databasePath: database.path,
        admit: (stage) => hooks.admit?.(stage),
      });
      return withSqliteWorkerOperationAdmission({ port: port1 }, () =>
        backend.execute({ type: "participant", input: { scope: seed.scope, params } }),
      );
    },
    patchEntry(input: Parameters<typeof commitSessionEntryPatch>[0]) {
      return withSqliteWorkerOperationAdmission({ port: port1 }, () =>
        commitSessionEntryPatch(input, context),
      );
    },
    commitLifecycle(input: Parameters<typeof commitSessionLifecycleProjection>[0]) {
      return withSqliteWorkerOperationAdmission({ port: port1 }, () =>
        commitSessionLifecycleProjection(input, context),
      );
    },
    receipt(): unknown {
      return receipts.shift();
    },
    prepare: (command: Command) => actor.prepare(command),
    nativeEntry: () => readExactSessionEntryRow(database, target.sessionKey)?.entry,
    restartActor() {
      actor.close();
      actor = createSessionActorWorker(context, () => target.database);
    },
    async reopenDatabase() {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      database = openOpenClawAgentDatabase(context.options);
    },
    closeActor: () => actor.close(),
    close() {
      actor.close();
      wire.mockRestore();
      admission.finish();
      port1.close();
      port2.close();
    },
  };
}

export type Fixture = ReturnType<typeof createFixture>;

export async function withActor(run: (fixture: Fixture) => void | Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createFixture();
    try {
      await run(fixture);
    } finally {
      fixture.close();
    }
  });
}
