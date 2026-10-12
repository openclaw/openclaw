import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readRecentSessionTranscriptMessageEventsFromProjection,
  readSessionTranscriptBoundedMessageTailPageFromProjection,
} from "../config/sessions/session-accessor.sqlite-active-events-read.js";
import { resolveConversationInDatabase } from "../config/sessions/session-accessor.sqlite-conversation-read.js";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptRunInputVisibilityFromProjection } from "../config/sessions/session-accessor.sqlite-history-input-visibility.js";
import {
  readSessionTranscriptHistoryEventPageFromProjection,
  readTranscriptDisplayDeltaFromProjection,
} from "../config/sessions/session-accessor.sqlite-history-query.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
  type SessionTranscriptBoundedMessageTailOptions,
} from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { readSessionTranscriptBindingFromProjection } from "../config/sessions/session-accessor.sqlite-transcript-binding.js";
import type { SessionTranscriptRawDeltaLimits } from "../config/sessions/session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import type { SessionConversationBinding } from "../config/sessions/session-history-types.js";
import { listSessionReactionsInDatabase } from "../config/sessions/session-reaction-store.read.js";
import { readSessionTranscriptAccountingFromProjection } from "../config/sessions/session-transcript-accounting.js";
import type { SessionTranscriptAccountingOptions } from "../config/sessions/session-transcript-accounting.types.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import type { OpenClawAgentReadOnlyDatabase } from "../state/openclaw-agent-db-readonly.js";
import { isSubagentCoordinationHistoryInput } from "./chat-display-projection.history.js";
import type { SessionArtifactReadQuery } from "./session-artifact-read.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createBoundSessionHistorySubagentSource } from "./session-history-subagent-sources.js";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import type { SubagentCoordinationDisplayResolver } from "./session-transcript-read.types.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

/** Source and run facts live only for one history operation, on its admitted database. */
export function createBoundSessionHistorySubagentProjection(
  readSnapshot: <T>(read: (projection: CurrentTranscriptProjection) => T) => T,
  stateDatabase: PreparedSessionHistoryReadTarget["stateDatabase"],
  readSourceDatabases: () => GatewaySessionStoreReadSources | undefined,
  preparedSource?: (sessionKey: string) => boolean | undefined,
): SubagentCoordinationDisplayResolver {
  const runs = new Map<
    string,
    ReturnType<typeof readSessionTranscriptRunInputVisibilityFromProjection>
  >();
  const readBoundSource = createBoundSessionHistorySubagentSource(
    readSnapshot,
    stateDatabase,
    readSourceDatabases,
  );
  const readSource = (sessionKey: string) =>
    preparedSource?.(sessionKey) ?? readBoundSource(sessionKey);
  return {
    isSubagentSession: readSource,
    isSubagentRunMessage(runId, messageSeq) {
      if (messageSeq === undefined) {
        return false;
      }
      let visibility = runs.get(runId);
      if (
        !visibility ||
        (visibility.hidden &&
          visibility.firstVisibleMessageSeq === undefined &&
          visibility.scannedThroughMessageSeq < messageSeq)
      ) {
        visibility = readSnapshot((projection) =>
          readSessionTranscriptRunInputVisibilityFromProjection(projection, {
            idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
            runId,
            messageSeq,
            previous: visibility?.hidden ? visibility : undefined,
            isHiddenInput: (message) => {
              const record = asOptionalRecord(message);
              return Boolean(record && isSubagentCoordinationHistoryInput(record, readSource));
            },
          }),
        );
        runs.set(runId, visibility);
      }
      return (
        visibility.hidden &&
        (visibility.firstVisibleMessageSeq === undefined ||
          messageSeq < visibility.firstVisibleMessageSeq)
      );
    },
  };
}

export function createReadonlySessionHistoryReader(
  target: Omit<PreparedSessionHistoryReadTarget, "sourceDiscovery">,
  resolveSourceDatabases?: () => GatewaySessionStoreReadSources | undefined,
) {
  let sourceDatabases = target.sourceDatabases;
  const readDatabase = <T>(read: (database: OpenClawAgentReadOnlyDatabase) => T): T => {
    const result = withScopedOpenClawAgentDatabaseReadOnly(
      (database) =>
        readWithCanonicalSessionAdmission(database, () => {
          // Repeat the original conditional row validation at every reader invocation,
          // after dispatch. A current entry may name a successor; it never selects this transcript.
          const entryValidationKey = target.entryValidationKey;
          if (entryValidationKey !== undefined) {
            readSessionEntryRow(database, entryValidationKey);
          }
          return read(database);
        }),
      target.database,
    );
    if (!result.found) {
      throw new SessionTranscriptStorageUnavailableError(result.reason);
    }
    return result.value;
  };
  const readSnapshot = <T>(read: (projection: CurrentTranscriptProjection) => T): T => {
    const result = readDatabase((database) =>
      readCurrentProjectionSnapshot(
        database,
        {
          agentId: target.transcript.agentId,
          sessionId: target.transcript.sessionId,
          sessionKey: target.transcript.sessionKey,
          databaseAgentId: target.database.agentId,
          path: target.database.path,
        },
        read,
      ),
    );
    if (result.kind === "unavailable") {
      throw new SessionTranscriptProjectionUnavailableError(target.transcript.sessionId);
    }
    return result.value;
  };
  const subagentCoordination = createBoundSessionHistorySubagentProjection(
    readSnapshot,
    target.stateDatabase,
    () => (sourceDatabases ??= resolveSourceDatabases?.()),
  );
  return {
    readRecentUsage: (maxBytes: number) =>
      readSnapshot((projection) =>
        aggregateSessionTranscriptUsage(
          readRecentSessionTranscriptMessageEventsFromProjection(projection, {
            maxBytes,
            maxLines: 1000,
            maxMessages: 1000,
          }).events.map(({ event }) => asOptionalRecord(event)?.message),
        ),
      ),
    readHistoryEventPage: (
      options: Parameters<typeof readSessionTranscriptHistoryEventPageFromProjection>[1],
    ) =>
      readSnapshot((projection) =>
        readSessionTranscriptHistoryEventPageFromProjection(projection, options),
      ),
    readHistoryRevision: () =>
      readSnapshot((projection) => ({
        database: projection.database.db,
        generation: projection.generation,
        indexedSeq: projection.state.indexedSeq,
        leafEventId: projection.state.leafEventId,
      })),
    readTranscriptAccounting: (options: SessionTranscriptAccountingOptions) =>
      readSnapshot((projection) =>
        readSessionTranscriptAccountingFromProjection(projection, options),
      ),
    readBoundedMessageTail: (options: SessionTranscriptBoundedMessageTailOptions) =>
      readSnapshot((projection) =>
        readSessionTranscriptBoundedMessageTailPageFromProjection(projection, options),
      ),
    readArtifactSummaries: async (query: Extract<SessionArtifactReadQuery, { kind: "list" }>) => {
      const { readArtifactSummariesFromProjection } = await import("./session-artifact-read.js");
      return readSnapshot((projection) => readArtifactSummariesFromProjection(projection, query));
    },
    readReactions: () =>
      readDatabase((database) => {
        if (!target.transcript.sessionKey) {
          throw new Error("Reaction reads require a session key");
        }
        return listSessionReactionsInDatabase(database, target.transcript.sessionKey, {
          sessionId: target.transcript.sessionId,
        });
      }),
    readConversationBinding: (conversationRef: string): SessionConversationBinding | null =>
      readDatabase((database) => {
        const conversation = resolveConversationInDatabase(database, conversationRef);
        if (!conversation) {
          return null;
        }
        const { channel, accountId, target: address, threadId, nativeChannelId } = conversation;
        return { channel, accountId, target: address, threadId, nativeChannelId };
      }),
    readTranscriptBinding: () =>
      readSnapshot((projection) => readSessionTranscriptBindingFromProjection(projection)),
    readTranscriptDisplayDelta: (limits: SessionTranscriptRawDeltaLimits) =>
      readSnapshot((projection) => readTranscriptDisplayDeltaFromProjection(projection, limits)),
    ...createSessionTranscriptReader({
      subagentCoordination,
      resolveTarget: async () => target.transcript,
      readSnapshot: async (_transcript, read) => readSnapshot(read),
    }),
    subagentCoordination,
  };
}
