import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareSessionHistorySubagentFacts } from "../../gateway/session-history-delta-visibility.js";
import { createBoundSessionHistorySubagentProjection } from "../../gateway/session-history-readonly-reader.js";
import { selectSessionTranscriptProjection } from "../../gateway/session-transcript-read-kernel.js";
import {
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "../../gateway/session-transcript-source-pages.js";
import { resolveGatewaySessionStoreReadSources } from "../../gateway/session-utils-store-sources.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { readSessionTranscriptBoundedMessageTailPageFromProjection } from "./session-accessor.sqlite-active-events-read.js";
import {
  readLatestSessionTranscriptMessageEvent,
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptVisibleMessageDeltaCore,
} from "./session-accessor.sqlite-active-events.js";
import { resolveConversationInDatabase } from "./session-accessor.sqlite-conversation-read.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { readTranscriptRawDeltaInDatabase } from "./session-accessor.sqlite-delta.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import {
  loadTranscriptReadSnapshotSync,
  readTranscriptExportSnapshotReadOnlySync,
} from "./session-accessor.sqlite-read.js";
import {
  iterateVisibleMessageMetadata,
  readVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { hasSessionTranscriptMessageInDatabase } from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { readHarnessCompletionSourceInDatabase } from "./session-harness-completion-source.kernel.js";
import {
  prepareSessionHistoryReadOperation,
  type SessionHistoryReadOperationRequest,
} from "./session-history-read-operation.worker.js";
import type {
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoHistoryOperations } from "./session-incognito-history-contract.js";
import { resolveIncognitoHistoryProjectionSelection } from "./session-incognito-history-selection.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import { readSessionTranscriptAccountingFromProjection } from "./session-transcript-accounting.js";
import {
  prepareSessionTranscriptAnchorMessageReader,
  readSessionTranscriptAnchorFactsInDatabase,
} from "./session-transcript-anchor-read.kernel.js";
import { isSessionTranscriptIndexStatusClean } from "./session-transcript-index-status.worker.js";
import { readSessionTranscriptMaintenance } from "./session-transcript-maintenance-read.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  runWithSessionTranscriptReadFence,
  resolveSqliteSessionTranscriptReadFence,
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
  const completionSources = new Map<
    string,
    IncognitoHistoryOperations["session.history.completion-source.open"]["input"]
  >();
  let prepared: PreparedHistoryRead<Command["type"]> | undefined;
  const prepare = async (command: Command) => {
    if (command.type === "session.history.memory-targets") {
      const { readMemorySessionTargets } = await import("./session-memory-targets.js");
      const selected = new Set(command.input.sessions.map((session) => session.sessionKey));
      prepared = prepareHistoryRead(command.type, () =>
        readMemorySessionTargets({
          ...command.input.selectors,
          agentId: database.agentId,
          storePath: database.path,
          env,
        }).filter(
          (target) =>
            target.resolution === "unresolved" ||
            (target.sessionKey !== undefined && selected.has(target.sessionKey)),
        ),
      );
      return;
    }
    if (command.type === "session.history.search") {
      const { sessions, ...selection } = command.input;
      const { searchSessionTranscriptsReadOnlySync } =
        await import("./session-transcript-search.js");
      prepared = prepareHistoryRead(command.type, () => {
        const {
          found: _found,
          revision: _revision,
          ...result
        } = sessions.length
          ? searchSessionTranscriptsReadOnlySync(
              {
                ...selection,
                agentId: database.agentId,
                sessionKeys: sessions.map((session) => session.sessionKey),
              },
              { agentId: database.agentId, path: database.path, env },
            )
          : { found: true, revision: undefined, hits: [], truncated: false };
        return {
          kind: "transcript-search",
          result: { ...result, indexing: !isSessionTranscriptIndexStatusClean(database.db) },
        };
      });
      return;
    }
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
    const memoryTarget = (readSessionId = sessionId) => {
      if (
        readSessionId !== sessionId &&
        !listTranscriptInstancesFromDatabase({
          database,
          currentEntries: { get: (key) => readExactSessionEntryRow(database, key, "list")?.entry },
          options: { sessionId: readSessionId, includeAllWindows: true },
        }).some((window) => window.sessionKey === sessionKey)
      ) {
        throw new Error("Incognito Memory transcript belongs to another session or is unavailable");
      }
      return { ...target, sessionId: readSessionId };
    };
    if (command.type === "session.history.visibility") {
      const sources = command.input.sourceDiscovery
        ? resolveGatewaySessionStoreReadSources(command.input.sourceDiscovery)
        : undefined;
      prepared = prepareHistoryRead(command.type, () => {
        const missingSources = new Set<string>();
        const incognitoSources = new Map(command.input.incognitoSources);
        const missing = new Error("Incognito source lineage requires its owning actor facts");
        const resolver = createBoundSessionHistorySubagentProjection(
          (read) => {
            const snapshot = readCurrentProjectionSnapshot(database, resolvedScope, read);
            if (snapshot.kind === "unavailable") {
              throw new SessionTranscriptProjectionUnavailableError(sessionId);
            }
            return snapshot.value;
          },
          command.input.stateDatabase,
          () => sources?.sources,
          (sourceSessionKey) => {
            if (!isIncognitoSessionKey(sourceSessionKey)) {
              return undefined;
            }
            const hidden = incognitoSources.get(sourceSessionKey);
            if (hidden === undefined) {
              missingSources.add(sourceSessionKey);
              throw missing;
            }
            return hidden;
          },
        );
        const facts = prepareSessionHistorySubagentFacts(resolver, (recording) => {
          for (const lookup of command.input.lookups) {
            try {
              if (lookup.kind === "session") {
                recording.isSubagentSession(lookup.sessionKey);
              } else {
                recording.isSubagentRunMessage(lookup.runId, lookup.messageSeq);
              }
            } catch (error) {
              if (error !== missing) {
                throw error;
              }
            }
          }
        });
        return { facts, missingSources: [...missingSources] };
      });
      return;
    }
    const selection = resolveIncognitoHistoryProjectionSelection(command);
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
      case "session.history.completion-source.open":
        prepared = prepareHistoryRead(command.type, () => {
          if (
            command.input.claim.requesterAgentId !== database.agentId ||
            command.input.claim.requesterSessionKey !== sessionKey ||
            command.input.claim.sessionId !== sessionId ||
            command.input.claim.lifecycleRevision !== command.input.lifecycleRevision
          ) {
            throw new Error("Incognito completion source belongs to another session");
          }
          if (completionSources.has(command.input.sourceId)) {
            throw new Error("Incognito completion source is already registered");
          }
          completionSources.set(command.input.sourceId, command.input);
        });
        return;
      case "session.history.completion-source.release":
        prepared = prepareHistoryRead(command.type, () => {
          completionSources.delete(command.input.sourceId);
        });
        return;
      case "session.history.harness-completion-source":
        if (
          command.input.claim.requesterAgentId !== database.agentId ||
          command.input.claim.requesterSessionKey !== sessionKey ||
          command.input.claim.sessionId !== sessionId
        ) {
          throw new Error("Harness completion source belongs to another incognito session");
        }
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readHarnessCompletionSourceInDatabase(database, command.input.claim, "committed"),
          ),
        );
        return;
      case "session.history.raw-delta":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readTranscriptRawDeltaInDatabase(database, resolvedScope, command.input.limits),
          ),
        );
        return;
      case "session.history.visible-delta":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readSessionTranscriptVisibleMessageDeltaCore(target, command.input.limits, {
              readOnly: true,
              resolvedScope,
            }),
          ),
        );
        return;
      case "session.history.conversation-binding":
        prepared = prepareHistoryRead(command.type, () => {
          const conversation = resolveConversationInDatabase(
            database,
            command.input.conversationRef,
          );
          if (!conversation) {
            return null;
          }
          const { channel, accountId, target: address, threadId, nativeChannelId } = conversation;
          return { channel, accountId, target: address, threadId, nativeChannelId };
        });
        return;
      case "session.history.anchors": {
        const readMessage = await prepareSessionTranscriptAnchorMessageReader(command.input);
        prepared = prepareHistoryRead(command.type, () =>
          readSessionTranscriptAnchorFactsInDatabase(
            database,
            resolvedScope,
            command.input,
            readMessage,
          ),
        );
        return;
      }
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
      case "session.history.branches": {
        const read = await prepareSessionHistoryReadOperation(
          {
            kind: "branch-summaries",
            database: physical,
            request: {
              sessionKey,
              sessionId,
              lifecycleRevision: command.input.lifecycleRevision,
            },
          },
          database,
        );
        prepared = prepareHistoryRead(command.type, () => read().result);
        return;
      }
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
      case "session.history.message-presence":
        prepared = prepareHistoryRead(command.type, () =>
          hasSessionTranscriptMessageInDatabase(database, sessionId),
        );
        return;
      case "session.history.visitor-source":
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () => {
            const snapshot = readCurrentProjectionSnapshot(
              database,
              resolvedScope,
              (projection) => {
                const { total } = resolveVisibleMessagePositions(projection);
                const start = resolveIntegerOption(command.input.offset, 0, { min: 0, max: total });
                let end = start;
                let bytes = 0;
                for (const row of iterateVisibleMessageMetadata(
                  projection,
                  start,
                  Math.min(total, start + SOURCE_PAGE_MAX_MESSAGES),
                )) {
                  if (row.serialized_bytes > SOURCE_PAGE_MAX_BYTES) {
                    throw new Error(
                      `Transcript source message exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`,
                    );
                  }
                  if (bytes + row.serialized_bytes > SOURCE_PAGE_MAX_BYTES) {
                    break;
                  }
                  bytes += row.serialized_bytes;
                  end++;
                }
                if (end === start && start < total) {
                  throw new Error("Transcript visitor page is incomplete");
                }
                const events = readVisibleMessageRange(projection, start, end);
                return {
                  ...(end < total ? { nextOffset: end } : {}),
                  messages: events.flatMap(({ event, seq }) => {
                    const message = asOptionalRecord(event)?.message;
                    return message === undefined ? [] : [{ message, seq }];
                  }),
                };
              },
            );
            if (snapshot.kind === "unavailable") {
              throw new SessionTranscriptProjectionUnavailableError(sessionId);
            }
            return snapshot.value;
          }),
        );
        return;
      case "session.history.memory-entry": {
        const { projectSessionEntryRecord } =
          await import("../../../packages/memory-host-sdk/src/host/session-entry-projection.js");
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () => {
            const snapshot = readTranscriptExportSnapshotReadOnlySync(
              memoryTarget(command.input.readSessionId),
              {
                projectEvent: command.input.includeMessages ? undefined : projectSessionEntryRecord,
              },
            );
            if (!snapshot) {
              throw new Error("Incognito actor transcript snapshot is unavailable");
            }
            return snapshot;
          }),
        );
        return;
      }
      case "session.history.memory-corpus": {
        const { readSessionTranscriptCorpusInventory } =
          await import("../../../packages/memory-host-sdk/src/host/session-transcript-corpus.js");
        const scope = {
          ...command.input.scope,
          env,
          normalizedAgentId: database.agentId,
          storePath: database.path,
          isSharedFixedStore: false,
          artifactDirs: [],
        };
        const selected = new Set(command.input.sessionKeys);
        prepared = prepareHistoryRead(command.type, () =>
          readSessionTranscriptCorpusInventory(
            scope,
            command.input.options,
            [],
            database.path,
          ).filter((entry) => entry.sessionKey !== undefined && selected.has(entry.sessionKey)),
        );
        return;
      }
      case "session.history.memory-reset-recall": {
        const { readSessionResetRecallCutoffInProcess } =
          await import("../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js");
        prepared = prepareHistoryRead(command.type, () =>
          runWithSessionTranscriptReadFence(admission, () =>
            readSessionResetRecallCutoffInProcess(memoryTarget(command.input.readSessionId)),
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
    completionFacts(sessionKey: string): IncognitoSessionFacts["completionSources"] {
      return [...completionSources.values()]
        .filter((source) => source.sessionKey === sessionKey)
        .map((source) => {
          let valid = false;
          try {
            valid = runWithSessionTranscriptReadFence(source.admission, () => {
              // Even an original admitted delivery must retain its exact branch/reset fence.
              if (source.admission) {
                resolveSqliteSessionTranscriptReadFence({
                  database,
                  agentId: database.agentId,
                  sessionKey,
                  sessionId: source.sessionId,
                });
              }
              const snapshot = readHarnessCompletionSourceInDatabase(database, source.claim);
              return (
                snapshot.entry?.sessionId === source.sessionId &&
                snapshot.entry?.lifecycleRevision === source.lifecycleRevision &&
                snapshot.validInput
              );
            });
          } catch (error) {
            if (!(error instanceof SessionTranscriptReadFenceError)) {
              throw error;
            }
          }
          return { sourceId: source.sourceId, valid };
        });
    },
    execute(command: Command, facts: IncognitoSessionFacts[]) {
      const targets =
        command.type === "session.history.search" ||
        command.type === "session.history.memory-targets"
          ? command.input.sessions
          : [command.input];
      for (const target of targets) {
        if (command.type === "session.history.completion-source.release") {
          continue;
        }
        const entry = readExactSessionEntryRow(database, target.sessionKey)?.entry;
        if (target.allowMissing) {
          if (
            entry ||
            (command.type !== "session.history.context" &&
              command.type !== "session.history.native-context" &&
              command.type !== "session.history.native-context-current" &&
              command.type !== "session.history.anchors")
          ) {
            throw new Error("Incognito missing context no longer matches its captured session");
          }
          continue;
        }
        if (
          !entry ||
          entry.sessionId !== target.sessionId ||
          entry.lifecycleRevision !== target.lifecycleRevision
        ) {
          throw new Error("Incognito history session generation is no longer current");
        }
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
    close() {
      prepared = undefined;
      completionSources.clear();
    },
  };
}
