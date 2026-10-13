import type { ContextEngineTurnOutboxWorkerOperations } from "../../agents/harness/context-engine-turn-outbox.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { createIncognitoDomainWorker } from "./session-incognito-domain.worker.js";
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
  const domain = createIncognitoDomainWorker<ContextEngineTurnOutboxWorkerOperations>(
    database,
    (stage) => {
      if (!active) {
        throw new Error("Incognito outbox has no admitted command");
      }
      validateTarget(active);
      admit(stage, [active.input.sessionKey]);
    },
  );
  return {
    async prepare(_command: Command) {
      await domain.prepare(runtimeProcessEntrypoints.contextEngineTurnOutbox);
    },
    execute(command: Command) {
      const executeDomain = <Key extends keyof ContextEngineTurnOutboxWorkerOperations>(inner: {
        type: Key;
        input: ContextEngineTurnOutboxWorkerOperations[Key]["input"];
      }) => {
        return {
          value: domain.execute(inner),
          keys: [command.input.sessionKey],
        };
      };
      active = command;
      try {
        return domain.run(() =>
          withSqlitePostCommitPublications(database.db, () => {
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
          }),
        );
      } finally {
        active = undefined;
      }
    },
    assertSettled() {
      domain.assertSettled();
      active = undefined;
    },
    close: () => domain.close(),
  };
}
