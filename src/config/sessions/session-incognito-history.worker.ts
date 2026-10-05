import { selectSessionTranscriptProjection } from "../../gateway/session-transcript-read-kernel.js";
import type { SessionTranscriptProjectionSelection } from "../../gateway/session-transcript-read.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "./session-accessor.sqlite-active-events-read.js";
import {
  readLatestSessionTranscriptMessageEvent,
  readRecentSessionTranscriptActiveEvents,
} from "./session-accessor.sqlite-active-events.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import {
  loadTranscriptReadSnapshotSync,
  readTranscriptExportSnapshotReadOnlySync,
} from "./session-accessor.sqlite-read.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import {
  prepareSessionHistoryReadOperation,
  type SessionHistoryReadOperationRequest,
} from "./session-history-read-operation.worker.js";
import type {
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import { readSessionTranscriptAnchorFactsInDatabase } from "./session-transcript-anchor-read.kernel.js";
import { readSessionTranscriptMaintenance } from "./session-transcript-maintenance-read.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";

type Command = SqliteWorkerCommand<IncognitoHistoryOperations>;

type PreparedHistoryRead<Key extends Command["type"]> = {
  type: Key;
  read(facts: IncognitoSessionFacts[]): IncognitoSessionOperations[Key]["output"];
};

function prepareHistoryRead<Key extends Command["type"]>(
  type: Key,
  read: () => IncognitoHistoryOperations[Key]["output"],
): PreparedHistoryRead<Key>;
function prepareHistoryRead(
  type: Command["type"],
  read: () => IncognitoHistoryOperations[Command["type"]]["output"],
) {
  return {
    type,
    read: (facts: IncognitoSessionFacts[]) => ({ value: read(), facts }),
  };
}

/** Reuse durable reader kernels on the actor's admitted connection, never its sentinel opener. */
export function createIncognitoHistoryWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
) {
  let prepared: PreparedHistoryRead<Command["type"]> | undefined;
  const prepare = async (command: Command) => {
    const { sessionKey, sessionId, admission } = command.input;
    const target = {
      agentId: database.agentId,
      storePath: database.path,
      sessionKey,
      sessionId,
      env,
    };
    const resolvedScope = {
      agentId: database.agentId,
      path: database.path,
      sessionKey,
      sessionId,
      env,
    };
    const physical = { agentId: database.agentId, path: database.path };
    const selection = historySelection(command);
    if (selection) {
      prepared = prepareHistoryRead(command.type, () =>
        runWithSessionTranscriptReadFence(admission, () => {
          const snapshot = readCurrentProjectionSnapshot(database, resolvedScope, (projection) =>
            selectSessionTranscriptProjection(projection, selection, sessionKey),
          );
          if (snapshot.kind === "unavailable") {
            throw new SessionTranscriptProjectionUnavailableError(sessionId);
          }
          return snapshot.value;
        }),
      );
      return;
    }
    let request: SessionHistoryReadOperationRequest;
    switch (command.type) {
      case "session.history.anchors":
        prepared = prepareHistoryRead(command.type, () =>
          readSessionTranscriptAnchorFactsInDatabase(database, resolvedScope, command.input),
        );
        return;
      case "session.history.accounting":
      case "session.history.bounded-tail":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () => {
            const snapshot = readCurrentProjectionSnapshot(database, resolvedScope, (projection) =>
              command.type === "session.history.accounting"
                ? readSessionTranscriptAccountingFromProjection(projection, command.input.options)
                : readSessionTranscriptBoundedMessageTailPageFromProjection(
                    projection,
                    command.input.options,
                  ),
            );
            if (snapshot.kind === "unavailable") {
              throw new SessionTranscriptProjectionUnavailableError(sessionId);
            }
            return snapshot.value;
          }),
        );
        return;
      case "session.history.pending-inputs":
        prepared = prepareHistoryRead(command.type, () =>
          readPendingInputHistoryInDatabase(database, {
            ...command.input.query,
            sessionKey,
            sessionId,
          }),
        );
        return;
      case "session.history.current-turn-entry":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readSessionTranscriptCurrentTurnEntry(target, {
              entryId: command.input.entryId,
              version: command.input.version,
              includeEntry: command.input.includeEntry,
              readOnly: true,
              resolvedScope,
            }),
          ),
        );
        return;
      case "session.history.maintenance":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readSessionTranscriptMaintenance(database, target, command.input.request),
          ),
        );
        return;
      case "session.history.recent-active-events":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readRecentSessionTranscriptActiveEvents(target, command.input.maxEvents, {
              readOnly: true,
              resolvedScope,
            }),
          ),
        );
        return;
      case "session.history.latest-active-message":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readLatestSessionTranscriptMessageEvent(target, { readOnly: true, resolvedScope }),
          ),
        );
        return;
      case "session.history.title":
        request = {
          kind: "session-title-fields",
          database: physical,
          scope: target,
          admission,
          includeInterSession: command.input.includeInterSession,
        };
        break;
      case "session.history.preview":
        request = {
          kind: "session-preview",
          database: physical,
          target,
          env,
          admission,
          maxItems: command.input.maxItems,
          maxChars: command.input.maxChars,
        };
        break;
      case "session.history.branches":
        request = {
          kind: "branch-summaries",
          request: {
            database: physical,
            sessionKey,
            sessionId,
            lifecycleRevision: command.input.lifecycleRevision,
          },
        };
        break;
      case "session.history.context":
        request = {
          kind: "model-context",
          target,
          admission,
          through: command.input.through,
          limits: command.input.limits,
        };
        break;
      case "session.history.match":
        request = {
          kind: "transcript-match",
          database: physical,
          request: { target: resolvedScope, match: command.input.match },
        };
        break;
      case "session.history.search": {
        const { query, limit, match, role, order } = command.input;
        request = {
          kind: "transcript-search",
          database: physical,
          params: { ...target, sessionKeys: [sessionKey], query, limit, match, role, order },
        };
        break;
      }
      case "session.history.watermark":
        request = { kind: "transcript-watermark", database: physical, scope: target };
        break;
      case "session.history.receipts":
        request = {
          kind: "session-pending-input-receipts",
          database: physical,
          ...target,
          runIds: command.input.runIds,
        };
        break;
      case "session.history.hydrate": {
        const { limits, maxEventBytes } = command.input;
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            limits
              ? {
                  kind: "bounded",
                  snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
                    ...limits,
                    readOnly: true,
                    resolvedScope,
                  }),
                }
              : {
                  kind: "full",
                  snapshot: loadTranscriptReadSnapshotSync(
                    { ...target, maxEventBytes },
                    {
                      readOnly: true,
                      resolvedScope,
                    },
                  ),
                },
          ),
        );
        return;
      }
      case "session.history.stats":
        prepared = prepareHistoryRead(command.type, () =>
          readTranscriptStatsFromDatabase(database, sessionId),
        );
        return;
      case "session.history.memory-entry": {
        const { projectSessionEntryRecord } =
          await import("../../../packages/memory-host-sdk/src/host/session-entry-projection.js");
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () => {
            const snapshot = readTranscriptExportSnapshotReadOnlySync(target, {
              projectEvent: projectSessionEntryRecord,
            });
            if (!snapshot) {
              throw new Error("Incognito actor transcript snapshot is unavailable");
            }
            return snapshot;
          }),
        );
        return;
      }
      case "session.history.memory-reset-recall": {
        const { readSessionResetRecallCutoffInProcess } =
          await import("../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js");
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readSessionResetRecallCutoffInProcess(target),
          ),
        );
        return;
      }
      case "session.history.native-context":
      case "session.history.native-context-current": {
        const {
          readSessionTranscriptContextMessages,
          validateSessionTranscriptContextAdmission,
          validateSessionTranscriptContextAnchor,
          validateSessionTranscriptContextVersion,
        } = await import("./session-accessor.sqlite-model-context.js");
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () => {
            try {
              if (command.type === "session.history.native-context-current") {
                if (admission) {
                  validateSessionTranscriptContextAdmission(target, admission);
                } else if (!command.input.through) {
                  validateSessionTranscriptContextVersion(target, command.input.version);
                }
                if (command.input.through) {
                  validateSessionTranscriptContextAnchor(target, command.input.through);
                }
                return { ok: true, value: undefined };
              }
              const value = readSessionTranscriptContextMessages(
                target,
                (messages, header, version) => ({
                  messages: [...messages],
                  header,
                  version,
                }),
              );
              return { ok: true, value };
            } catch (error) {
              if (error instanceof SessionTranscriptReadFenceError) {
                return { ok: false, message: error.message };
              }
              throw error;
            }
          }),
        );
        return;
      }
      default:
        throw new Error("Unsupported incognito history operation");
    }
    const read = await prepareSessionHistoryReadOperation(request, database);
    prepared = prepareHistoryRead(command.type, read);
  };
  return {
    prepare,
    execute(command: Command, facts: IncognitoSessionFacts[]) {
      const target = command.input;
      const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
      if (
        !entry ||
        entry.sessionId !== target.sessionId ||
        entry.lifecycleRevision !== target.lifecycleRevision
      ) {
        throw new Error("Incognito history session generation is no longer current");
      }
      if (!prepared || prepared.type !== command.type) {
        throw new Error("Incognito history read was not prepared");
      }
      try {
        return prepared.read(facts);
      } finally {
        prepared = undefined;
      }
    },
    assertSettled() {
      prepared = undefined;
    },
  };
}

function historySelection(command: Command): SessionTranscriptProjectionSelection | undefined {
  switch (command.type) {
    case "session.history.delta":
      return { kind: "delta", options: command.input.options };
    case "session.history.count":
      return { kind: "count" };
    case "session.history.recent":
      return { kind: "recent", options: command.input.options };
    case "session.history.page":
      return { kind: "page", options: command.input.options };
    case "session.history.around-id":
      return { kind: "around-id", options: command.input.options };
    case "session.history.source":
      return { kind: "source", options: command.input.options };
    case "session.history.by-id":
      return { kind: "by-id", messageId: command.input.messageId, options: command.input.options };
    case "session.history.lookup":
      return { kind: "lookup", messageId: command.input.messageId };
    default:
      return undefined;
  }
}
