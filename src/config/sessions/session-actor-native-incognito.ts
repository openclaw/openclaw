import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { readSqliteDatabaseWriteRevision } from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerNativeSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { retainAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorNativeIncognitoIdentity,
  SessionActorOperations,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor, type SessionActorTransport } from "./session-actor.js";
import { createSessionActorWorker } from "./session-actor.worker.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { prepareSessionTurnPredicates } from "./session-turn-predicate.js";
import { prepareVoiceTranscriptCommit } from "./session-turn.worker.js";

type Options = OpenClawAgentDatabaseOptions & { path: string };
type NativeTarget = SessionActorTarget & { database: SessionActorNativeIncognitoIdentity };
type NativeAdmission = Parameters<Parameters<SessionActorTransport["run"]>[1]>[1];
type Request = {
  assertCurrent(): void;
  authorize: Parameters<SessionActorTransport["run"]>[1];
  native: NativeAdmission;
  committed?: { facts: unknown };
};

/** Capture the existing native connection; absence never admits a replacement owner. */
export function captureNativeIncognitoSessionActorTarget(params: {
  database: Options;
  sessionKey: string;
}): NativeTarget | undefined {
  if (
    !isIncognitoSessionKey(params.sessionKey) ||
    !isIncognitoOpenClawAgentSqlitePath(params.database.path, params.database)
  ) {
    return undefined;
  }
  const database = getOpenClawAgentDatabaseIfOpen(params.database);
  if (!database) {
    return undefined;
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "symbol") {
    throw new Error("Native incognito session requires its memory database");
  }
  assertCanonicalSessionKeyWrite(params.sessionKey, database.agentId);
  return {
    database: {
      kind: "native-incognito",
      agentId: database.agentId,
      nativeLocation: database.path,
      incarnation: identity.incarnation,
    },
    sessionKey: params.sessionKey,
  };
}

/** Convert native source locators to the captured connection's serializable actor identity. */
export function captureNativeIncognitoSessionActorSources(params: {
  database: Options;
  target: NativeTarget;
  sources: readonly SessionSourcePredicate[];
}): SessionSourcePredicate[] {
  const database = getOpenClawAgentDatabaseIfOpen(params.database);
  const expected = params.target.database;
  if (!database) {
    throw new Error("Native incognito source owner is unavailable");
  }
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (
    typeof identity.identity !== "symbol" ||
    identity.incarnation !== expected.incarnation ||
    database.agentId !== expected.agentId ||
    database.path !== expected.nativeLocation
  ) {
    throw new Error("Native incognito source changed its captured owner");
  }
  return params.sources.map((predicate) => {
    const { source } = predicate;
    if (
      source.agentId !== database.agentId ||
      source.path !== database.path ||
      (source.databaseIdentity !== identity.identity &&
        source.databaseIdentity !== identity.incarnation)
    ) {
      throw new Error("Native incognito source belongs to another database");
    }
    return structuredClone({
      ...predicate,
      source: { ...source, databaseIdentity: identity.incarnation },
    });
  });
}

function createNativeBackend(database: OpenClawAgentDatabase, options: Options) {
  let request: Request | undefined;
  const current = () => {
    if (!request) {
      throw new Error("Native session actor has no executing request");
    }
    request.assertCurrent();
    return request;
  };
  const context: AgentWorkerOperationContext = {
    options,
    open() {
      current();
      return database;
    },
    admit(stage, facts) {
      const selected = current();
      selected.authorize({ stage, facts }, selected.native, () => {
        selected.assertCurrent();
        return true;
      });
    },
    writeTransaction(operationLabel, _owner, write) {
      current();
      return runOpenClawAgentWriteTransaction(
        (opened) => {
          if (opened !== database) {
            throw new Error("Native session actor changed its writer");
          }
          return write(opened);
        },
        options,
        { operationLabel },
      );
    },
    captureCommitReceipt(connection, facts) {
      const selected = current();
      const captured = structuredClone(facts);
      if (
        !stageSqliteTransactionState(connection, {
          stage() {},
          rollback() {},
          commit() {
            selected.committed = { facts: captured };
          },
        })
      ) {
        throw new Error("Native session actor receipt requires managed settlement");
      }
    },
  };
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const backend = createSessionActorWorker(context, () => ({
    kind: "native-incognito",
    agentId: database.agentId,
    nativeLocation: database.path,
    incarnation: identity.incarnation,
  }));
  registerNodeSqliteDisposeCallback(database.db, () => backend.close());
  function execute<Key extends keyof SessionActorOperations>(
    selected: Request,
    command: { type: Key; input: SessionActorOperations[Key]["input"] },
  ): SessionActorOperations[Key]["output"];
  function execute(
    selected: Request,
    command: SqliteWorkerCommand<SessionActorOperations>,
  ): SessionActorOperations[keyof SessionActorOperations]["output"] {
    const previous = request;
    request = selected;
    try {
      return backend.execute(command);
    } finally {
      request = previous;
    }
  }
  return { execute };
}

const nativeBackends = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeIncognitoSessionActorBackends"),
  () => new WeakMap<DatabaseSync, ReturnType<typeof createNativeBackend>>(),
);

/** Pre-P12 adapter: the current native owner keeps all data, writes, and authority. */
export async function captureNativeIncognitoSessionActor(params: {
  database: Options;
  target: NativeTarget;
  lifetime: SessionActorLifetime;
}): Promise<SessionActor> {
  const options = {
    ...params.database,
    env: Object.freeze({ ...(params.database.env ?? process.env) }),
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database) {
    throw new Error("Native incognito session owner is unavailable");
  }
  const target = structuredClone(params.target);
  const assertOwner = () => {
    if (
      !database.db.isOpen ||
      database.agentId !== target.database.agentId ||
      database.path !== target.database.nativeLocation ||
      readOpenClawAgentDatabaseIdentity(database).incarnation !== target.database.incarnation ||
      getOpenClawAgentDatabaseIfOpen(options) !== database
    ) {
      throw new Error("Native incognito session actor lost its captured owner");
    }
  };
  const lifetime = {
    assertCurrent() {
      params.lifetime.assertCurrent();
      assertOwner();
    },
    assertReadable() {
      params.lifetime.assertReadable();
      assertOwner();
    },
  };
  lifetime.assertCurrent();
  if (
    !captureNativeIncognitoSessionActorTarget({ database: options, sessionKey: target.sessionKey })
  ) {
    throw new Error("Native incognito session actor target is invalid");
  }
  const release = retainAgentDatabase(database.db);
  try {
    // Prepare asynchronous kernel dependencies before entering the native writer FIFO.
    await Promise.all([prepareSessionTurnPredicates(), prepareVoiceTranscriptCommit()]);
    lifetime.assertCurrent();
    let backend = nativeBackends.get(database.db);
    if (!backend) {
      backend = createNativeBackend(database, options);
      nativeBackends.set(database.db, backend);
    }
    const selectedBackend = backend;
    return createSessionActor({
      target,
      lifetime,
      replica: createSessionActorReplica({
        target,
        lifetime,
        currentWriteToken() {
          if (!database.db.isOpen) {
            return undefined;
          }
          const revision = readSqliteDatabaseWriteRevision(database.db);
          return revision === undefined ? undefined : `${target.database.incarnation}:${revision}`;
        },
      }),
      transport: {
        run: (operation, authorize) =>
          runOpenClawAgentWriteAdmission(
            options,
            () => {
              lifetime.assertCurrent();
              return operation({
                captureGeneration: () => ({ assertCurrent: assertOwner }),
                async execute(command) {
                  const settled = Promise.withResolvers<
                    { kind: "completed" } | { kind: "unknown"; error: unknown }
                  >();
                  let settlement: SqliteWorkerNativeSettlement | undefined;
                  const selected: Request = {
                    assertCurrent: () => lifetime.assertCurrent(),
                    authorize,
                    native: {
                      admission: {
                        get committed() {
                          return selected.committed;
                        },
                        get settlement() {
                          return settlement;
                        },
                      },
                      retained: { settled: settled.promise },
                    },
                  };
                  try {
                    assertTransactionUsable(database.db);
                    if (database.db.isTransaction) {
                      throw new Error("Native session actor has an unsettled transaction");
                    }
                    const result = selectedBackend.execute(selected, command);
                    const unknown = "kind" in result && result.kind === "unknown";
                    settlement = {
                      kind: unknown ? "unknown" : "completed",
                      committed: selected.committed,
                    };
                    if (unknown) {
                      settled.resolve({ kind: "unknown", error: result.error });
                    } else {
                      settled.resolve({ kind: "completed" });
                    }
                    return result;
                  } catch (error) {
                    settlement = { kind: "unknown", committed: selected.committed };
                    settled.resolve({ kind: "unknown", error });
                    throw error;
                  }
                },
              });
            },
            true,
          ),
        async release() {
          release();
        },
      },
    });
  } catch (error) {
    release();
    throw error;
  }
}
