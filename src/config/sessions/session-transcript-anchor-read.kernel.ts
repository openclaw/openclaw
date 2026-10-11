import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import {
  readExactSessionEntryRow,
  readSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptMetadataInDatabase } from "./session-accessor.sqlite-metadata-read.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  readActiveTranscriptEntryAnchorFromProjection,
  readActiveTranscriptEntryAnchorInTransaction,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { loadTranscriptEventRowsAfterSeqInDatabase } from "./session-accessor.sqlite-transcript-incremental-read.js";
import {
  hasSessionTranscriptMessageInDatabase,
  readTranscriptHeaderFromDatabase,
} from "./session-accessor.sqlite-transcript-metadata-read.js";
import { readSessionTranscriptWatermarkInDatabase } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionTranscriptAnchorSelection = {
  entryIds: readonly string[];
  afterSeq?: number;
  /** Payload selection stays in the history lane and shares the anchor snapshot. */
  includeMessagesForRunId?: string;
  includeSession?: boolean;
  includeHeader?: boolean;
  includeWatermark?: boolean;
  includeMessagePresence?: boolean;
  includeMetadata?: boolean;
  contextValidation?: Parameters<typeof validateSessionTranscriptContextInDatabase>[2];
  contextAuthority?: true | { permissionMode: InternalSessionEntry["permissionMode"] };
  replayValidation?: Pick<
    SessionTranscriptWriteScope,
    "expectedLifecycleRevision" | "expectedWriterRunId"
  > & { allowInitial: boolean; admission?: UserTurnTranscriptAdmissionReceipt };
};

type AnchorMessageReader = (projection: CurrentTranscriptProjection, entryId: string) => unknown;

/** Load display policy before entering the synchronous anchor snapshot. */
export async function prepareSessionTranscriptAnchorMessageReader(
  selection: SessionTranscriptAnchorSelection,
): Promise<AnchorMessageReader | undefined> {
  if (selection.includeMessagesForRunId === undefined) {
    return undefined;
  }
  const { readSessionTranscriptHistoryEventByIdFromProjection } =
    await import("./session-accessor.sqlite-history-query.js");
  return (projection, entryId) =>
    asOptionalRecord(
      readSessionTranscriptHistoryEventByIdFromProjection(projection, entryId, {
        currentOnly: true,
        maxBytes: Number.MAX_SAFE_INTEGER,
      })?.event,
    )?.message;
}

/** The cohort's entry and optional reply-tail facts belong to the same snapshot. */
export function readSessionTranscriptAnchorFactsInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedTranscriptScope,
  selection: SessionTranscriptAnchorSelection,
  readMessage?: AnchorMessageReader,
  projection?: CurrentTranscriptProjection,
  preparedEntry?: InternalSessionEntry,
): SessionTranscriptAnchorFacts {
  if (
    projection &&
    (!database.db.isTransaction ||
      projection.database.db !== database.db ||
      projection.database.path !== database.path ||
      projection.database.agentId !== database.agentId ||
      projection.resolved.agentId !== resolved.agentId ||
      projection.resolved.sessionId !== resolved.sessionId ||
      projection.resolved.sessionKey !== resolved.sessionKey)
  ) {
    throw new Error("Transcript anchor projection differs from its selected session snapshot");
  }
  if (selection.includeMessagesForRunId !== undefined && !readMessage) {
    throw new Error("Transcript anchor message selection requires prepared display policy");
  }
  const read = (): SessionTranscriptAnchorFacts => {
    const readWatermark = () =>
      projection
        ? { generation: projection.version.generation, maxSeq: projection.version.rawSeq }
        : readSessionTranscriptWatermarkInDatabase(database, resolved.sessionId);
    const contextEntry = selection.contextAuthority
      ? (preparedEntry ?? readSessionEntryRow(database, resolved.sessionKey)?.entry)
      : undefined;
    const contextAuthority = selection.contextAuthority
      ? {
          entry: contextEntry && {
            sessionId: contextEntry.sessionId,
            lifecycleRevision: contextEntry.lifecycleRevision,
            activeWriterRunId: contextEntry.activeWriterRunId,
            cliHistoryBoundary: contextEntry.cliHistoryBoundary,
            permissionMode: contextEntry.permissionMode,
          },
          watermark: readWatermark(),
        }
      : undefined;
    // Session replacement and permission refusal precede transcript-anchor refusal.
    if (
      selection.contextAuthority &&
      (!contextEntry ||
        contextEntry.sessionId !== resolved.sessionId ||
        (selection.contextAuthority !== true &&
          contextEntry.permissionMode !== selection.contextAuthority.permissionMode))
    ) {
      return { anchors: [], contextAuthority };
    }
    let replayValidated: SessionTranscriptAnchorFacts["replayValidated"];
    const replay = selection.replayValidation;
    if (replay) {
      const entry = preparedEntry ?? readSessionEntryRow(database, resolved.sessionKey)?.entry;
      if (
        !entry &&
        replay.allowInitial &&
        readTranscriptHeaderFromDatabase(database, resolved.sessionId) === undefined
      ) {
        replayValidated = "initial";
      } else if (
        !entry ||
        entry.sessionId !== resolved.sessionId ||
        (replay.expectedLifecycleRevision !== undefined &&
          entry.lifecycleRevision !== replay.expectedLifecycleRevision) ||
        (replay.expectedWriterRunId !== undefined &&
          entry.activeWriterRunId !== replay.expectedWriterRunId)
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      } else {
        replayValidated = "current";
      }
    }
    const fence = replay
      ? runWithSessionTranscriptReadFence(replay.admission, () =>
          resolveSqliteSessionTranscriptReadFence({ database, ...resolved }),
        )
      : undefined;
    const context = selection.contextValidation;
    if (context) {
      // Appends can supersede or complete a prepared replay; only snapshots retain a prefix.
      validateSessionTranscriptContextInDatabase(
        database,
        resolved,
        context,
        replay ? "exact" : "prefix",
      );
    }
    const validated = {
      ...(selection.includeMetadata
        ? { metadata: readSessionTranscriptMetadataInDatabase(database, resolved.sessionId) }
        : {}),
      ...(selection.includeMessagePresence
        ? { messagePresence: hasSessionTranscriptMessageInDatabase(database, resolved.sessionId) }
        : {}),
      ...(selection.includeWatermark
        ? {
            watermark: contextAuthority?.watermark ?? readWatermark(),
          }
        : {}),
      ...(contextAuthority ? { contextAuthority } : {}),
      ...(context ? { contextValidated: true as const } : {}),
      ...(replayValidated ? { replayValidated } : {}),
    };
    const entry = selection.includeSession
      ? (preparedEntry ??
        readExactSessionEntryRow(database, resolved.sessionKey, "list", "canonical")?.entry)
      : undefined;
    const session = entry
      ? { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision }
      : undefined;
    const sessionFacts = selection.includeSession ? { session } : {};
    const header: Pick<SessionTranscriptAnchorFacts, "header"> = {};
    if (selection.includeHeader) {
      try {
        header.header = readTranscriptHeaderFromDatabase(database, resolved.sessionId);
      } catch {
        // Lifecycle header metadata is best effort; reader admission and owner checks still fail closed.
      }
    }
    const readAnchors = (currentProjection?: CurrentTranscriptProjection) => {
      const anchors = new Map<string, TranscriptEntryAnchor | undefined>();
      const readAnchor = (entryId: string) => {
        if (!anchors.has(entryId)) {
          const anchor = currentProjection
            ? readActiveTranscriptEntryAnchorFromProjection(currentProjection, entryId)
            : readActiveTranscriptEntryAnchorInTransaction({ database, resolved, entryId });
          anchors.set(
            entryId,
            fence && anchor && anchor.rawSeq >= fence.beforeRawSeq ? undefined : anchor,
          );
        }
        return anchors.get(entryId);
      };
      const selected = selection.entryIds.flatMap((entryId) => readAnchor(entryId) ?? []);
      if (selection.afterSeq === undefined) {
        return { anchors: selected, ...validated, ...sessionFacts, ...header };
      }
      const rows = loadTranscriptEventRowsAfterSeqInDatabase(
        database,
        resolved.sessionId,
        selection.afterSeq,
      );
      const entries: NonNullable<SessionTranscriptAnchorFacts["tail"]>["entries"] = [];
      for (const { event } of rows) {
        const row = asOptionalRecord(event);
        const message = asOptionalRecord(row?.message);
        if (
          typeof row?.id !== "string" ||
          (message?.role !== "user" && message?.role !== "assistant")
        ) {
          continue;
        }
        const runId = readSessionTranscriptRunId(message);
        const includeMessage =
          currentProjection !== undefined &&
          selection.includeMessagesForRunId !== undefined &&
          message.role === "assistant" &&
          runId === selection.includeMessagesForRunId;
        const anchor =
          message.role === "user" || includeMessage ? readAnchor(row.id) : anchors.get(row.id);
        const displayed =
          includeMessage && anchor ? readMessage?.(currentProjection, row.id) : undefined;
        entries.push({
          entryId: row.id,
          role: message.role,
          ...(runId ? { runId } : {}),
          ...(anchor ? { anchor } : {}),
          ...(displayed ? { message: displayed } : {}),
        });
      }
      return {
        anchors: selection.includeMessagesForRunId
          ? [...anchors.values()].flatMap((anchor) => anchor ?? [])
          : selected,
        ...validated,
        ...sessionFacts,
        ...header,
        tail: { lastSeq: rows.at(-1)?.seq, entries },
      };
    };
    if (projection) {
      return readAnchors(projection);
    }
    if (
      (selection.replayValidation && selection.entryIds.length > 0) ||
      selection.includeMessagesForRunId !== undefined
    ) {
      const result = readCurrentProjectionSnapshot(database, resolved, readAnchors);
      if (result.kind !== "value") {
        throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
      }
      return result.value;
    }
    return readAnchors();
  };
  return database.db.isTransaction
    ? read()
    : runSqliteDeferredTransactionSync(database.db, read, {
        databaseLabel: database.path,
        operationLabel: "session transcript anchors read",
      });
}
