import { randomUUID } from "node:crypto";
import type { ContextEngineTurnOutboxWorkerOperations } from "../../agents/harness/context-engine-turn-outbox.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import { createAgentDatabaseDomainOwner } from "../../state/openclaw-agent-execution-domain.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { IncognitoOutboxOperations } from "./session-incognito-outbox-contract.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

type Command = SqliteWorkerCommand<IncognitoOutboxOperations>;

/** The existing outbox domain owns all transitions on the actor's retained connection. */
export function createIncognitoOutboxWorker(
  database: OpenClawAgentDatabase,
  admit: (stage: "transaction" | "commit", keys: readonly string[]) => void,
) {
  let active: Command | undefined;
  const validateTarget = (command: Command) => {
    const { sessionKey, sessionId } = command.input;
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    if (!entry || entry.sessionId !== sessionId) {
      throw new Error("Incognito outbox session generation is no longer current");
    }
    const assertAnchor = (anchor: TranscriptEntryAnchor) => {
      if (
        anchor.agentId !== database.agentId ||
        anchor.storePath !== database.path ||
        anchor.sessionKey !== sessionKey ||
        anchor.sessionId !== sessionId
      ) {
        throw new Error("Incognito outbox anchor belongs to another session");
      }
    };
    let advancementKey: string | undefined;
    switch (command.type) {
      case "session.outbox.acceptIntent":
      case "session.outbox.publishClosedTurn":
        assertAnchor(command.input.boundary.admission);
        assertAnchor(command.input.boundary.terminal);
        advancementKey = command.input.boundary.admission.logicalTurnId;
        break;
      case "session.outbox.prepareRun":
      case "session.outbox.enqueueIntent":
      case "session.outbox.discardIntent":
        if (command.input.admission) {
          assertAnchor(command.input.admission);
          advancementKey = command.input.admission.logicalTurnId;
        }
        break;
      case "session.outbox.complete":
      case "session.outbox.recordFailure":
        advancementKey = command.input.advancementKey;
        break;
      case "session.outbox.hasPending":
      case "session.outbox.listPendingSessions":
      case "session.outbox.readNextPending":
        break;
    }
    if (advancementKey !== undefined) {
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getNodeSqliteKysely<OpenClawAgentDatabaseSchema>(database.db)
          .selectFrom("context_engine_turn_outbox")
          .select("session_id")
          .where("advancement_key", "=", advancementKey),
      );
      if (row && row.session_id !== sessionId) {
        throw new Error("Incognito outbox advancement belongs to another session");
      }
    }
  };
  const domain = createAgentDatabaseDomainOwner({
    databasePath: database.path,
    assertCurrent: () => database.db,
    assertCleanupCurrent() {},
    admit(stage) {
      if (!active) {
        throw new Error("Incognito outbox has no admitted command");
      }
      validateTarget(active);
      admit(stage, [active.input.sessionKey]);
    },
  });
  let binding: { id: string; moduleUrl: string; input: undefined } | undefined;
  return {
    async prepare(_command: Command) {
      binding = {
        id: randomUUID(),
        moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.contextEngineTurnOutbox).href,
        input: undefined,
      };
      await domain.prepare({ type: "database.domain.bind", input: binding });
    },
    execute(command: Command) {
      const bound = binding;
      if (!bound) {
        throw new Error("Incognito outbox domain was not prepared");
      }
      const executeDomain = <Key extends keyof ContextEngineTurnOutboxWorkerOperations>(inner: {
        type: Key;
        input: ContextEngineTurnOutboxWorkerOperations[Key]["input"];
      }) => {
        const value = domain.execute({
          type: "database.domain.execute",
          input: { id: bound.id, command: inner },
        });
        return {
          // SAFETY: the statically bound domain owns each typed outbox command's result.
          value: value as ContextEngineTurnOutboxWorkerOperations[Key]["output"],
          keys: [command.input.sessionKey],
        };
      };
      active = command;
      try {
        domain.execute({ type: "database.domain.bind", input: bound });
        return withSqlitePostCommitPublications(database.db, () => {
          switch (command.type) {
            case "session.outbox.prepareRun":
              return executeDomain({ type: "prepareRun", input: command.input });
            case "session.outbox.listPendingSessions":
              return executeDomain({ type: "listPendingSessions", input: command.input });
            case "session.outbox.readNextPending":
              return executeDomain({ type: "readNextPending", input: command.input });
            case "session.outbox.complete":
              return executeDomain({ type: "complete", input: command.input });
            case "session.outbox.recordFailure":
              return executeDomain({ type: "recordFailure", input: command.input });
            case "session.outbox.hasPending":
              return executeDomain({ type: "hasPending", input: command.input });
            case "session.outbox.enqueueIntent":
              return executeDomain({ type: "enqueueIntent", input: command.input });
            case "session.outbox.acceptIntent":
              return executeDomain({ type: "acceptIntent", input: command.input });
            case "session.outbox.publishClosedTurn":
              return executeDomain({ type: "publishClosedTurn", input: command.input });
            case "session.outbox.discardIntent":
              return executeDomain({ type: "discardIntent", input: command.input });
          }
          throw new Error("Unsupported incognito outbox operation");
        });
      } finally {
        domain.assertSettled();
        domain.execute({ type: "database.domain.close", input: { id: bound.id } });
        binding = undefined;
        active = undefined;
      }
    },
    assertSettled() {
      domain.assertSettled();
      binding = undefined;
      active = undefined;
    },
    close: () => domain.close(),
  };
}
