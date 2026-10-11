import { MessageChannel, MessagePort, receiveMessageOnPort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionActorHotState,
  SessionActorOperations,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

type Command = SqliteWorkerCommand<SessionActorOperations>;
export type Mutation = Exclude<Command, { type: "session.actor.read" }>;

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
    transactions: number;
  } = { transactions: 0 };
  const context: AgentWorkerOperationContext = {
    open: () => database,
    options: { agentId: "main", path: database.path },
    admit: (stage, facts) => hooks.admit?.(stage, facts),
    writeTransaction(_label, _owner, write) {
      hooks.transactions += 1;
      const result = runSqliteImmediateTransactionSync(database.db, () => write(database), {
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
    mutate(command: Mutation) {
      const value = execute(command);
      if (!("kind" in value)) {
        throw new Error("Actor mutation returned a read snapshot");
      }
      return value;
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
