import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, vi } from "vitest";
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
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
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
import type { SessionParticipantRecord } from "./session-membership-facts.types.js";
import type { SessionParticipantRecordInput } from "./session-sharing-store.types.js";
import { bindSqliteWorkerBackend as bindSharingBackend } from "./session-sharing-store.worker.js";

type Command = SqliteWorkerCommand<SessionActorOperations>;
type Outcome = SessionActorOutcome<SessionActorPhaseResults[SessionActorPhase]>;
export type Mutation = Exclude<Command, { type: "session.actor.read" }>;

export function participantRecord(
  id: string,
  contributionCount: number,
  firstPromptedAt: number,
  lastPromptedAt = firstPromptedAt,
): SessionParticipantRecord {
  return { identity: { type: "agent", id }, contributionCount, firstPromptedAt, lastPromptedAt };
}

export function sessionActorFileTarget(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionKey: string,
): SessionActorTarget & { database: Extract<SessionActorTarget["database"], { kind: "file" }> } {
  const identity = readOpenClawAgentDatabaseIdentity(database);
  return {
    sessionKey,
    database: {
      kind: "file",
      physicalIdentity: identity.identity,
      birthtime: identity.birthtime,
      nativeLocation: database.path,
    },
  };
}

export function seedSessionActorOutcomeTransferEntry(
  fixture: Pick<ReturnType<typeof createSessionCompoundWorkerFixture>, "database" | "scope">,
): void {
  // Transfer coverage needs a genuinely oversized result, not copied history indexes.
  runSqliteImmediateTransactionSync(fixture.database.db, () =>
    writeSessionEntry(fixture.database, fixture.scope.sessionKey, {
      sessionId: fixture.scope.sessionId,
      updatedAt: 1,
      skillsSnapshot: { prompt: "s".repeat(SQLITE_WORKER_MAX_MESSAGE_BYTES + 1024), skills: [] },
    }),
  );
}

export function createSessionActorWorkerFixture<Database extends OpenClawAgentDatabase>(
  seed: {
    database: Database;
    scope: ReturnType<typeof createSessionCompoundWorkerFixture>["scope"];
  },
  reopen: (options: AgentWorkerOperationContext["options"]) => Database,
) {
  let database = seed.database;
  const target = sessionActorFileTarget(database, seed.scope.sessionKey);
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
    assert(isRecord(received), "Synchronous actor fixture lost its native frame");
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
  const withAdmission = <T>(run: () => T): T =>
    withSqliteWorkerOperationAdmission({ port: port1 }, run);
  const execute = (command: Command) => withAdmission(() => actor.execute(command));
  return {
    target,
    scope: { ...seed.scope, path: database.path },
    hooks,
    get database() {
      return database;
    },
    read(selected: SessionActorTarget = target): SessionActorHotState {
      const value = execute({ type: "session.actor.read", input: { target: selected } });
      assert(!("kind" in value), "Actor read returned a mutation outcome");
      return value;
    },
    mutate(command: Mutation): Outcome {
      commitFacts = undefined;
      transferredOutcome = undefined;
      outcomeTransfer = createSqliteWorkerTransferCollector("outcome", (value) => {
        transferredOutcome = value;
      });
      const value = execute(command);
      assert("kind" in value, "Actor mutation returned a read snapshot");
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
      assert(
        isRecord(evidence) && evidence.kind === "committed",
        "Actor acknowledgement has no native committed outcome",
      );
      // The worker's native receipt is the typed outcome; the command reply carries only failure.
      const committed = evidence as Extract<Outcome, { kind: "committed" }>;
      return value.failure ? { ...committed, failure: value.failure } : committed;
    },
    reply: () => lastReply,
    participant(params: SessionParticipantRecordInput) {
      const backend = bindSharingBackend(undefined, {
        database: database.db,
        databasePath: database.path,
        admit: (stage) => hooks.admit?.(stage),
      });
      return withAdmission(() =>
        backend.execute({ type: "participant", input: { scope: seed.scope, params } }),
      );
    },
    patchEntry: (input: Parameters<typeof commitSessionEntryPatch>[0]) =>
      withAdmission(() => commitSessionEntryPatch(input, context)),
    commitLifecycle: (input: Parameters<typeof commitSessionLifecycleProjection>[0]) =>
      withAdmission(() => commitSessionLifecycleProjection(input, context)),
    receipt: (): unknown => receipts.shift(),
    prepare: (command: Command) => actor.prepare(command),
    prepareTurn: (input: Parameters<typeof actor.prepareTurn>[0]) => actor.prepareTurn(input),
    writeEntry(entry: Parameters<typeof writeSessionEntry>[2], sessionKey = target.sessionKey) {
      return runSqliteImmediateTransactionSync(database.db, () =>
        writeSessionEntry(database, sessionKey, entry),
      );
    },
    nativeEntry: () => readExactSessionEntryRow(database, target.sessionKey)?.entry,
    restartActor() {
      actor.close();
      actor = createSessionActorWorker(context, () => target.database);
    },
    async reopenDatabase() {
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      database = reopen(context.options);
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

function createFixture() {
  return createSessionActorWorkerFixture(createSessionCompoundWorkerFixture(), (options) => {
    const reopened = openOpenClawAgentDatabase(options);
    return Object.assign(reopened, { db: requireNativeSqliteDatabase(reopened.db) });
  });
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
