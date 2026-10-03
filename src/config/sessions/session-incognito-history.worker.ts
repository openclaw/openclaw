import {
  selectSessionTranscriptProjection,
  type SessionTranscriptProjectionSelection,
} from "../../gateway/session-transcript-read-kernel.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import {
  prepareSessionHistoryReadOperation,
  type SessionHistoryReadOperationRequest,
} from "./session-history-read-operation.worker.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "./session-incognito-history-contract.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

type Command = SqliteWorkerCommand<IncognitoHistoryOperations>;

/** Reuse durable reader kernels on the actor's admitted connection, never its sentinel opener. */
export function createIncognitoHistoryWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
) {
  let prepared:
    | (() => IncognitoHistoryOperations[keyof IncognitoHistoryOperations]["output"])
    | undefined;
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
      prepared = () =>
        runWithSessionTranscriptReadFence(admission, () => {
          const snapshot = readCurrentProjectionSnapshot(database, resolvedScope, (projection) =>
            selectSessionTranscriptProjection(projection, selection, sessionKey),
          );
          if (snapshot.kind === "unavailable") {
            throw new SessionTranscriptProjectionUnavailableError(sessionId);
          }
          return snapshot.value;
        });
      return;
    }
    let request: SessionHistoryReadOperationRequest;
    switch (command.type) {
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
        prepared = () =>
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
          );
        return;
      }
      case "session.history.stats":
        prepared = () => readTranscriptStatsFromDatabase(database, sessionId);
        return;
      default:
        throw new Error("Unsupported incognito history operation");
    }
    prepared = await prepareSessionHistoryReadOperation(request, database);
  };
  return {
    prepare,
    execute(target: IncognitoHistoryTarget) {
      const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
      if (
        !entry ||
        entry.sessionId !== target.sessionId ||
        entry.lifecycleRevision !== target.lifecycleRevision
      ) {
        throw new Error("Incognito history session generation is no longer current");
      }
      if (!prepared) {
        throw new Error("Incognito history read was not prepared");
      }
      try {
        return prepared();
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
