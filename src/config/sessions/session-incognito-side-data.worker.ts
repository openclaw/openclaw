import { randomUUID } from "node:crypto";
import { mutateAcpSessionEntryInWorker } from "../../acp/runtime/session-meta-entry.worker.js";
import type { BoardWriteOperations } from "../../boards/sqlite-board-operations.js";
import {
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetDocument,
} from "../../boards/sqlite-board-store.kernel.js";
import type { HeartbeatOutcomeWorkerOperations } from "../../infra/heartbeat-outcome-store.worker.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { readSessionProgressCard } from "../../session-cards/progress-card-store.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { createAgentDatabaseDomainOwner } from "../../state/openclaw-agent-execution-domain.js";
import { loadAgentReactionOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { createWorkerOperationRegistry } from "../../state/worker-operation-registry.js";
import { readLegacyAcpMigrationContextInDatabase } from "./session-accessor.sqlite-acp-provenance.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { readSessionGroupCategoryKeys } from "./session-group-categories.read.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import { readSessionMembershipRowsInDatabase } from "./session-membership-facts.js";
import { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";

type DomainOperations = SessionSharingWorkerOperations &
  HeartbeatOutcomeWorkerOperations &
  BoardWriteOperations;
type Command = SqliteWorkerCommand<IncognitoSideDataOperations>;

/** Adapters borrow the actor connection; domain kernels still own their transactions. */
export function createIncognitoSideDataWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
  admit: (stage: "transaction" | "commit", keys: readonly string[]) => void,
) {
  let keys: string[] = [];
  const domain = createAgentDatabaseDomainOwner({
    databasePath: database.path,
    assertCurrent: () => database.db,
    assertCleanupCurrent() {},
    admit: (stage) => admit(stage, keys),
  });
  let binding: { id: string; moduleUrl: string; input: undefined } | undefined;
  const reactions = createWorkerOperationRegistry<
    Pick<IncognitoSideDataOperations, "session.reaction.set">,
    AgentWorkerOperationContext,
    "session.reaction.set"
  >({ "session.reaction.set": loadAgentReactionOperations });
  const scope = (sessionKey: string) => ({
    agentId: database.agentId,
    storePath: database.path,
    sessionKey,
    env,
  });
  const context: AgentWorkerOperationContext = {
    open: () => database,
    options: { agentId: database.agentId, path: database.path, env },
    admit: (stage) => admit(stage, keys),
    writeTransaction: (operationLabel, _owner, write) =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Incognito reaction lost its native owner");
          }
          admit("transaction", keys);
          return write(current);
        },
        { agentId: database.agentId, path: database.path, env },
        { operationLabel },
      ),
  };
  return {
    async prepare(command: Command) {
      const module =
        command.type.startsWith("session.sharing.") || command.type === "session.category.apply"
          ? runtimeProcessEntrypoints.sessionSharingStore
          : command.type.startsWith("session.heartbeat.")
            ? runtimeProcessEntrypoints.heartbeatOutcomeStore
            : command.type === "session.boards.applyOps" ||
                command.type === "session.boards.putWidget" ||
                command.type === "session.boards.grant"
              ? runtimeProcessEntrypoints.boardStore
              : undefined;
      if (module) {
        binding = {
          id: randomUUID(),
          moduleUrl: resolveRuntimeWorkerUrl(module).href,
          input: undefined,
        };
        await domain.prepare({ type: "database.domain.bind", input: binding });
      }
      await reactions.prepare(command.type);
    },
    execute(command: Command, selectedKeys: string[]) {
      keys = selectedKeys;
      const bound = binding;
      const executeDomain = <Key extends keyof DomainOperations>(inner: {
        type: Key;
        input: DomainOperations[Key]["input"];
      }): DomainOperations[Key]["output"] => {
        if (!bound) {
          throw new Error("Incognito side-data domain was not prepared");
        }
        return domain.execute({
          type: "database.domain.execute",
          input: { id: bound.id, command: inner },
        }) as DomainOperations[Key]["output"]; // SAFETY: the static domain owns this typed result.
      };
      try {
        if (bound) {
          domain.execute({ type: "database.domain.bind", input: bound });
        }
        const value = withSqlitePostCommitPublications(database.db, () => {
          switch (command.type) {
            case "session.boards.applyOps":
              return executeDomain({ type: "boards.applyOps", input: command.input });
            case "session.boards.putWidget":
              return executeDomain({ type: "boards.putWidget", input: command.input });
            case "session.boards.grant":
              return executeDomain({ type: "boards.grant", input: command.input });
            case "session.boards.readSnapshot":
              return readBoardSnapshotWithHtmlViewMetadata(database, command.input.sessionKey);
            case "session.boards.readWidgetDocument":
              return readBoardWidgetDocument(
                database,
                command.input.sessionKey,
                command.input.name,
                command.input.contentKind,
              );
            case "session.acp.source":
              return readLegacyAcpMigrationContextInDatabase(database, command.input.sessionKey);
            case "session.acp.entry": {
              const { entry } = mutateAcpSessionEntryInWorker(
                database,
                { agentId: database.agentId, path: database.path, env },
                command.input,
                (stage) => admit(stage, keys),
                false,
              );
              return { entry };
            }
            case "session.sharing.add":
              return executeDomain({
                type: "add",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.remove":
              return executeDomain({
                type: "remove",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.participant":
              return executeDomain({
                type: "participant",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.category.apply": {
              // Both commands use the same binding and FIFO turn; the exact-row plan stays native.
              const input = { ...command.input, scope: scope("") };
              const prepared = executeDomain({ type: "category.prepare", input });
              keys = prepared;
              return executeDomain({ type: "category.apply", input });
            }
            case "session.heartbeat.persist":
              return executeDomain({ type: "persist", input: command.input });
            case "session.heartbeat.claim":
              return executeDomain({ type: "claim", input: command.input });
            case "session.reaction.set":
              return reactions.execute(command, context);
            case "session.category.keys":
              return readSessionGroupCategoryKeys(database, command.input.name);
            case "session.members.read":
              return listSessionMembersInDatabase(database, command.input.sessionKey);
            case "session.participants.read":
              return (
                participantRecordsBySessionKey(database.db, keys).get(command.input.sessionKey) ??
                []
              );
            case "session.catalog.read": {
              const rows = readSessionMembershipRowsInDatabase(database, command.input.sessionKeys);
              keys = rows.map(([key]) => key);
              return rows;
            }
            case "session.reactions.read":
              return listSessionReactionsInDatabase(
                database,
                command.input.sessionKey,
                command.input,
              );
            case "session.progressCard.get":
              return readSessionProgressCard(database.db, command.input.sessionKey);
          }
          throw new Error("Unsupported incognito side-data operation");
        });
        return { value, keys };
      } finally {
        if (bound) {
          domain.assertSettled();
          domain.execute({ type: "database.domain.close", input: { id: bound.id } });
          binding = undefined;
        }
      }
    },
    assertSettled() {
      domain.assertSettled();
      // Admission/key validation may refuse after prepare without entering execute.
      binding = undefined;
    },
    close: () => domain.close(),
  };
}
