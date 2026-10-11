import { randomUUID } from "node:crypto";
import { mutateAcpSessionEntryInWorker } from "../../acp/runtime/session-meta-entry.worker.js";
import type { BoardWriteOperations } from "../../boards/sqlite-board-operations.js";
import {
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardSessionKeys,
  readBoardWidgetDocument,
} from "../../boards/sqlite-board-store.kernel.js";
import { readSessionTitleFieldsFromTranscript } from "../../gateway/session-transcript-title-reader.js";
import type { MessageToolRunOutcomeWorkerOperations } from "../../infra/message-tool-run-outcome-store.worker.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { takeSqliteWorkerOperationAdmissionAttachment } from "../../infra/sqlite-worker-operation-admission.js";
import { readSessionProgressCard } from "../../session-cards/progress-card-store.js";
import type { ProgressCardWorkerOperations } from "../../session-cards/progress-card-store.worker.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { createAgentDatabaseDomainOwner } from "../../state/openclaw-agent-execution-domain.js";
import { loadAgentReactionOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { createWorkerOperationRegistry } from "../../state/worker-operation-registry.js";
import { readSessionTerminalFallbackModel } from "../../status/session-fallback-model.js";
import { readTrajectoryRuntimeRetentionLease } from "../../trajectory/runtime-retention.contract.js";
import { readSessionActivitySummary } from "./activity-summary.js";
import { readLegacyAcpMigrationContextInDatabase } from "./session-accessor.sqlite-acp-provenance.js";
import {
  readExactSessionEntryRow,
  readSessionChildEntriesInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import { readSessionGroupCategoryKeys } from "./session-group-categories.read.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import { readSessionMembershipRowsInDatabase } from "./session-membership-facts.js";
import { listSessionReactionsInDatabase } from "./session-reaction-store.read.js";
import { readSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";
import { listSessionSuggestionsInDatabase } from "./session-suggestion-store.kernel.js";

type DomainOperations = SessionSharingWorkerOperations &
  MessageToolRunOutcomeWorkerOperations &
  ProgressCardWorkerOperations &
  BoardWriteOperations;
type Command = SqliteWorkerCommand<IncognitoSideDataOperations>;

/** Adapters borrow the actor connection; domain kernels still own their transactions. */
export function createIncognitoSideDataWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
  admit: (stage: "transaction" | "commit", keys: readonly string[]) => void,
) {
  let keys: string[] = [];
  let appendTrajectory:
    | typeof import("../../trajectory/runtime-store.sqlite.js").appendSqliteTrajectoryRuntimeEventsWithWriter
    | undefined;
  let readTrajectory:
    | typeof import("../../trajectory/runtime-store.sqlite.js").loadSqliteTrajectoryRuntimeEventRowsSync
    | undefined;
  let trajectoryRetention:
    | typeof import("../../trajectory/runtime-retention.sqlite.js")
    | undefined;
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
      if (command.type === "session.trajectory.read") {
        readTrajectory ??= (await import("../../trajectory/runtime-store.sqlite.js"))
          .loadSqliteTrajectoryRuntimeEventRowsSync;
      }
      if (command.type === "session.trajectory.append") {
        appendTrajectory ??= (await import("../../trajectory/runtime-store.sqlite.js"))
          .appendSqliteTrajectoryRuntimeEventsWithWriter;
      }
      if (command.type.startsWith("session.trajectory.retention.")) {
        trajectoryRetention ??= await import("../../trajectory/runtime-retention.sqlite.js");
      }
      const module =
        command.type.startsWith("session.sharing.") || command.type === "session.category.apply"
          ? runtimeProcessEntrypoints.sessionSharingStore
          : command.type === "session.boards.applyOps" ||
              command.type === "session.boards.putWidget" ||
              command.type === "session.boards.grant"
            ? runtimeProcessEntrypoints.boardStore
            : command.type === "session.progressCard.put"
              ? runtimeProcessEntrypoints.progressCardStore
              : command.type === "session.messageToolOutcome.record"
                ? runtimeProcessEntrypoints.messageToolRunOutcomeStore
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
      const result = <Value>(value: Value) => ({ value, keys });
      const executeDomain = <Key extends keyof DomainOperations>(inner: {
        type: Key;
        input: DomainOperations[Key]["input"];
      }): { value: DomainOperations[Key]["output"]; keys: string[] } => {
        if (!bound) {
          throw new Error("Incognito side-data domain was not prepared");
        }
        return result(
          domain.execute({
            type: "database.domain.execute",
            input: { id: bound.id, command: inner },
          }) as DomainOperations[Key]["output"], // SAFETY: the static domain owns this typed result.
        );
      };
      try {
        if (bound) {
          domain.execute({ type: "database.domain.bind", input: bound });
        }
        return withSqlitePostCommitPublications(database.db, () => {
          switch (command.type) {
            case "session.trajectory.read": {
              if (!readTrajectory) {
                throw new Error("Incognito trajectory read was not prepared");
              }
              return result(
                readTrajectory({
                  ...command.input,
                  agentId: database.agentId,
                  storePath: database.path,
                  env,
                }).map((row) => row.event),
              );
            }
            case "session.trajectory.retention.prepare": {
              if (!trajectoryRetention) {
                throw new Error("Trajectory retention was not prepared");
              }
              const state = trajectoryRetention.trajectoryRuntimeRetentionState(database);
              if (!trajectoryRetention.trajectoryRuntimeRetentionDue(state, command.input.now)) {
                return result(undefined);
              }
              const sweepId = trajectoryRetention.beginTrajectoryRuntimeRetention(
                database.db,
                readTrajectoryRuntimeRetentionLease(takeSqliteWorkerOperationAdmissionAttachment()),
              );
              return result({
                sweepId,
                snapshot: trajectoryRetention.prepareTrajectoryRuntimeRetention(
                  database.db,
                  command.input,
                  command.input.now,
                ),
              });
            }
            case "session.trajectory.retention.delete": {
              if (!trajectoryRetention) {
                throw new Error("Trajectory retention was not prepared");
              }
              const retention = trajectoryRetention;
              const batch = retention.selectTrajectoryRuntimeRetentionBatch(
                database.db,
                command.input,
              );
              // Changing actor commands retain a commit receipt even for a refresh-only result.
              const deleted = context.writeTransaction(
                "trajectory.runtime.retention.delete",
                "Trajectory retention",
                (current) => {
                  const value = retention.deleteTrajectoryRuntimeRetention(current, batch);
                  admit("commit", keys);
                  return value;
                },
              );
              if (deleted.complete) {
                retention.trajectoryRuntimeRetentionState(database).sweptAt = command.input.now;
              }
              return result(deleted);
            }
            case "session.trajectory.append": {
              if (!appendTrajectory) {
                throw new Error("Incognito trajectory append was not prepared");
              }
              appendTrajectory(command.input, (label, write) =>
                context.writeTransaction(label, "Trajectory append", (current) => {
                  const entry = readExactSessionEntryRow(current, command.input.sessionKey)?.entry;
                  if (
                    entry?.sessionId !== command.input.sessionId ||
                    entry.lifecycleRevision !== command.input.lifecycleRevision
                  ) {
                    throw new Error("Incognito trajectory session changed before append");
                  }
                  const appended = write(current);
                  admit("commit", keys);
                  return appended;
                }),
              );
              return result(undefined);
            }
            case "session.messageToolOutcome.record": {
              if (command.input.agent_id !== database.agentId) {
                throw new Error("Message-tool outcome belongs to another incognito actor");
              }
              // Canonical actor admission already installed this table; only record here.
              const receipt = executeDomain({ type: "record", input: command.input }).value;
              if (!receipt.ok) {
                const error = new Error("Message-tool outcome transaction failed");
                retainOpenClawStateWorkerErrorPayload(error, receipt.error);
                throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
              }
              return result(receipt.value);
            }
            case "session.progressCard.put": {
              const receipt = executeDomain({ type: "put", input: command.input }).value;
              if (!receipt.ok) {
                const error = new Error("Progress-card transaction failed");
                retainOpenClawStateWorkerErrorPayload(error, receipt.error);
                throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
              }
              return result(receipt.value);
            }
            case "session.boards.applyOps":
              return executeDomain({ type: "boards.applyOps", input: command.input });
            case "session.boards.putWidget":
              return executeDomain({ type: "boards.putWidget", input: command.input });
            case "session.boards.grant":
              return executeDomain({ type: "boards.grant", input: command.input });
            case "session.boards.readSnapshot":
              return result(
                readBoardSnapshotWithHtmlViewMetadata(database, command.input.sessionKey),
              );
            case "session.boards.readWidgetDocument":
              return result(
                readBoardWidgetDocument(
                  database,
                  command.input.sessionKey,
                  command.input.name,
                  command.input.contentKind,
                ),
              );
            case "session.row.read": {
              const { sessionKey } = command.input;
              const entry = readExactSessionEntryRow(database, sessionKey, "list")?.entry;
              return result(
                entry
                  ? {
                      row: {
                        sessionKey,
                        entry,
                        hasBoard: readBoardSessionKeys(database, [sessionKey]).has(sessionKey),
                        activitySummaryWatermark: readSessionActivitySummary(entry)
                          ? readSessionTranscriptWatermarkInDatabase(database, entry.sessionId)
                          : undefined,
                      },
                      children: readSessionChildEntriesInDatabase(database, sessionKey, "list"),
                      titleFields: readSessionTitleFieldsFromTranscript(
                        { ...scope(sessionKey), sessionId: entry.sessionId, sessionEntry: entry },
                        { readOnly: true },
                      ),
                      terminalModel: readSessionTerminalFallbackModel({
                        sessionEntry: entry,
                        sessionScope: scope(sessionKey),
                      }),
                    }
                  : undefined,
              );
            }
            case "session.acp.source":
              return result(
                readLegacyAcpMigrationContextInDatabase(database, command.input.sessionKey),
              );
            case "session.acp.entry": {
              const { entry } = mutateAcpSessionEntryInWorker(
                database,
                { agentId: database.agentId, path: database.path, env },
                command.input,
                (stage) => admit(stage, keys),
                false,
              );
              return result({ entry });
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
            case "session.sharing.owner.assign":
              return executeDomain({
                type: "owner.assign",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.suggestion.add":
              return executeDomain({
                type: "suggestion.add",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.suggestion.claim":
              return executeDomain({
                type: "suggestion.claim",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.suggestion.release":
              return executeDomain({
                type: "suggestion.release",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.sharing.suggestion.finalize":
              return executeDomain({
                type: "suggestion.finalize",
                input: { ...command.input, scope: scope(command.input.sessionKey) },
              });
            case "session.category.apply": {
              // Both commands use the same binding and FIFO turn; the exact-row plan stays native.
              const input = { ...command.input, scope: scope("") };
              const prepared = executeDomain({ type: "category.prepare", input });
              keys = prepared.value;
              return executeDomain({ type: "category.apply", input });
            }
            case "session.reaction.set":
              return result(reactions.execute(command, context));
            case "session.category.keys":
              return result(readSessionGroupCategoryKeys(database, command.input.name));
            case "session.members.read":
              return result(readSessionMembersInDatabase(database, command.input.sessionKey));
            case "session.suggestions.read":
              return result(
                listSessionSuggestionsInDatabase(
                  database,
                  command.input.sessionKey,
                  command.input.params,
                ),
              );
            case "session.participants.read":
              return result(
                participantRecordsBySessionKey(database.db, keys).get(command.input.sessionKey) ??
                  [],
              );
            case "session.catalog.read": {
              const rows = readSessionMembershipRowsInDatabase(database, command.input.sessionKeys);
              keys = rows.map(([key]) => key);
              return result(rows);
            }
            case "session.reactions.read":
              return result(
                listSessionReactionsInDatabase(database, command.input.sessionKey, command.input),
              );
            case "session.progressCard.get":
              return result(readSessionProgressCard(database.db, command.input.sessionKey));
          }
          throw new Error("Unsupported incognito side-data operation");
        });
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
