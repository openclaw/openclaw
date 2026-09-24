import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  readSessionTranscriptFailureRunId,
  readSessionTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { isVisibleTranscriptRecord } from "../../sessions/transcript-visible-record.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  hashSessionArchiveBytes,
  MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES,
} from "./session-accessor.sqlite-archive-artifact.js";
import { withTranscriptArchiveSelection } from "./session-accessor.sqlite-archive-selection.js";
import {
  MAX_TASK_ARCHIVE_RECORD_BYTES,
  readTranscriptArchiveRecords,
} from "./session-accessor.sqlite-archive-stream.js";
import type {
  TranscriptArchivePageBinding,
  TranscriptArchivePagePlan,
  TranscriptArchivePageResult,
  TranscriptArchiveReadPlan,
  TranscriptArchiveReadResult,
} from "./session-accessor.sqlite-archive-types.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import { readSessionTranscriptHeaderStartedAt } from "./transcript-header.js";

type ArchiveDatabase = Pick<DB, "session_transcript_archives">;

export function listTranscriptArchivesFromDatabase(
  { db, agentId }: Pick<OpenClawAgentDatabase, "db" | "agentId">,
  logicalAgentId: string | undefined,
  selectors: readonly string[],
  archiveNames: readonly string[],
) {
  // Archive metadata is optional until the first archive write.
  if (!tableExists(db, "session_transcript_archives")) {
    return [];
  }
  let query = getNodeSqliteKysely<ArchiveDatabase>(db)
    .selectFrom("session_transcript_archives")
    .select([
      "archive_name as archiveName",
      "session_id as sessionId",
      "session_key as sessionKey",
      "created_at as createdAt",
    ])
    .orderBy("created_at")
    .orderBy("session_id");
  query = query.where((expression) =>
    expression.or([
      ...(selectors.length > 0
        ? [expression("session_id", "in", selectors), expression("session_key", "in", selectors)]
        : []),
      ...(archiveNames.length > 0 ? [expression("archive_name", "in", archiveNames)] : []),
    ]),
  );
  const rows = executeSqliteQuerySync(db, query).rows;
  return rows
    .map((row) =>
      Object.assign(row, { agentId: resolveAgentIdFromSessionKey(row.sessionKey, agentId) }),
    )
    .filter((row) => logicalAgentId === undefined || row.agentId === logicalAgentId);
}

/** Scan one canonical read snapshot without constructing the decoded history. */
export async function readTranscriptArchiveFinalInWorker(
  plan: TranscriptArchiveReadPlan,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptArchiveReadResult> {
  const opened = openOpenClawAgentDatabaseReadOnly({
    agentId: plan.agentId,
    path: plan.databasePath,
    env,
  });
  if (!opened.found) {
    return {};
  }
  const database = opened.database;
  let transactionOpen = false;
  try {
    database.db.exec("BEGIN"); // sqlite-allow-raw: keep archive identities and bytes in one read snapshot.
    transactionOpen = true;
    const archives = listTranscriptArchivesFromDatabase(
      database,
      plan.logicalAgentId,
      [plan.sessionId ?? plan.sessionKey],
      [],
    ).toReversed();
    let result: TranscriptArchiveReadResult = {};
    for (const archive of archives) {
      if (
        plan.sessionId
          ? archive.sessionId !== plan.sessionId
          : archive.sessionKey !== plan.sessionKey
      ) {
        continue;
      }
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        getNodeSqliteKysely<ArchiveDatabase>(database.db)
          .selectFrom("session_transcript_archives")
          .select(["archive_blob", "archive_sha256", "encoding"])
          .where("archive_name", "=", archive.archiveName)
          .where("session_id", "=", archive.sessionId)
          .where("session_key", "=", archive.sessionKey),
      );
      if (!row) {
        continue;
      }
      if (hashSessionArchiveBytes(row.archive_blob) !== row.archive_sha256) {
        throw new Error("Archived transcript bytes do not match their registered hash.");
      }
      result = await findArchivedFinal(
        row.archive_blob,
        row.encoding === "zstd",
        archive.sessionId,
        plan.runId,
      );
      if (result.event !== undefined) {
        break;
      }
    }
    database.db.exec("COMMIT"); // sqlite-allow-raw: release the completed read snapshot.
    transactionOpen = false;
    return result;
  } finally {
    try {
      if (transactionOpen) {
        database.db.exec("ROLLBACK"); // sqlite-allow-raw: release a failed read snapshot.
      }
    } finally {
      database.close();
    }
  }
}

async function findArchivedFinal(
  bytes: Uint8Array,
  compressed: boolean,
  sessionId: string,
  runId: string,
): Promise<TranscriptArchiveReadResult> {
  const { isVisibleSubagentResultEventForRun } =
    await import("../../agents/subagents/announce/subagent-announce-result.js");
  const result: TranscriptArchiveReadResult = {};
  await scanArchivedTranscript(bytes, compressed, sessionId, (event) => {
    if (isVisibleSubagentResultEventForRun(event, runId)) {
      result.event = event;
    }
  });
  return result;
}

async function scanArchivedTranscript(
  bytes: Uint8Array,
  compressed: boolean,
  sessionId: string,
  visit: (event: TranscriptEvent, seq: number) => void,
  decodedBudget?: { remainingBytes: number },
  maxRecordBytes?: number,
): Promise<number | undefined> {
  const input = Readable.from(
    (function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        yield bytes.subarray(offset, offset + 64 * 1024);
      }
    })(),
  );
  const optionalZlib: Partial<typeof zlib> = zlib;
  const createZstdDecompress = optionalZlib.createZstdDecompress;
  if (compressed && !createZstdDecompress) {
    throw new Error("Cannot decode compressed transcript archive: this runtime lacks zstd support");
  }
  let headerRead = false;
  let sessionStartedAt: number | undefined;
  // The session header occupies physical ordinal zero in the archived transcript.
  let seq = 1;
  const scan = async (source: Readable) => {
    for await (const record of readTranscriptArchiveRecords(source, maxRecordBytes)) {
      const event: unknown = JSON.parse(record.toString("utf8"));
      if (!headerRead) {
        if (!isRecord(event) || event.type !== "session" || event.id !== sessionId) {
          throw new Error("Archived transcript header does not match its registered session.");
        }
        headerRead = true;
        sessionStartedAt = readSessionTranscriptHeaderStartedAt(event, sessionId);
      } else {
        visit(event, seq++);
      }
    }
  };
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (decodedBudget) {
        decodedBudget.remainingBytes -= chunk.byteLength;
      }
      callback(
        decodedBudget !== undefined && decodedBudget.remainingBytes < 0
          ? new Error("Archived transcript exceeds the bounded read size.")
          : null,
        chunk,
      );
    },
  });
  if (compressed && createZstdDecompress) {
    if (decodedBudget === undefined) {
      await pipeline(input, createZstdDecompress.call(zlib), scan);
    } else {
      await pipeline(input, createZstdDecompress.call(zlib), bound, scan);
    }
  } else if (decodedBudget === undefined) {
    await pipeline(input, scan);
  } else {
    await pipeline(input, bound, scan);
  }
  if (!headerRead) {
    throw new Error("Archived transcript header does not match its registered session.");
  }
  return sessionStartedAt;
}

type ArchivePageCursor = TranscriptArchivePageBinding & {
  sessionKey: string;
  runId: string;
  beforeSeq: number;
};

function readArchivePageCursor(plan: TranscriptArchivePagePlan): ArchivePageCursor | undefined {
  if (plan.cursor === undefined) {
    return undefined;
  }
  if (plan.cursor.length > 4_096) {
    throw new Error("Invalid archived transcript cursor.");
  }
  let cursor: unknown;
  try {
    const bytes = Buffer.from(plan.cursor, "base64url");
    if (bytes.toString("base64url") !== plan.cursor) {
      throw new Error("Noncanonical archived transcript cursor.");
    }
    cursor = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid archived transcript cursor.");
  }
  if (
    !isRecord(cursor) ||
    cursor.sessionKey !== plan.sessionKey ||
    cursor.runId !== plan.runId ||
    typeof cursor.sessionId !== "string" ||
    typeof cursor.generation !== "string" ||
    typeof cursor.sha256 !== "string" ||
    typeof cursor.beforeSeq !== "number" ||
    !Number.isSafeInteger(cursor.beforeSeq) ||
    cursor.beforeSeq < 0
  ) {
    throw new Error("Invalid archived transcript cursor.");
  }
  return {
    sessionKey: cursor.sessionKey,
    runId: cursor.runId,
    sessionId: cursor.sessionId,
    generation: cursor.generation,
    sha256: cursor.sha256,
    beforeSeq: cursor.beforeSeq,
  };
}

function sameArchiveBinding(
  left: TranscriptArchivePageBinding,
  right: TranscriptArchivePageBinding,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.sha256 === right.sha256
  );
}

/** Select a unique run-owned archive, never the newest archive for a reused key. */
export async function readTranscriptArchivePageInWorker(
  plan: TranscriptArchivePagePlan,
  env: NodeJS.ProcessEnv,
): Promise<TranscriptArchivePageResult | undefined> {
  const [
    { prepareChatHistoryRecoveryMessages },
    { createSubagentCoordinationHistoryProjection, createPreSessionStartAnnouncePairFilter },
    { createBoundSessionHistorySubagentSource },
    { projectTranscriptEntryMessage },
  ] = await Promise.all([
    import("../../gateway/chat-display-projection.core.js"),
    import("../../gateway/chat-display-projection.history.js"),
    import("../../gateway/session-history-subagent-sources.js"),
    import("../../gateway/session-transcript-entry-message.js"),
  ]);
  const cursor = readArchivePageCursor(plan);
  const expectedBinding = plan.verifyBinding ?? cursor;
  const opened = openOpenClawAgentDatabaseReadOnly({
    agentId: plan.agentId,
    path: plan.databasePath,
    env,
  });
  if (!opened.found) {
    if (expectedBinding) {
      throw new Error("Archived transcript is no longer available.");
    }
    return undefined;
  }
  const database = opened.database;
  let transactionOpen = false;
  try {
    database.db.exec("BEGIN"); // sqlite-allow-raw: bind archive selection and content to one read snapshot.
    transactionOpen = true;
    let result: TranscriptArchivePageResult | undefined;
    let foundRun = false;
    if (
      resolveAgentIdFromSessionKey(plan.sessionKey, database.agentId) === plan.logicalAgentId &&
      tableExists(database.db, "session_transcript_archives")
    ) {
      const archiveQuery = getNodeSqliteKysely<ArchiveDatabase>(database.db)
        .selectFrom("session_transcript_archives")
        .where("session_key", "=", plan.sessionKey);
      const sizing = executeSqliteQueryTakeFirstSync(
        database.db,
        archiveQuery.select(({ fn }) => [
          fn.countAll<number>().as("count"),
          fn.sum<number>(fn<number>("length", ["archive_blob"])).as("bytes"),
        ]),
      );
      if (
        sizing &&
        (sizing.count > MAX_VISIBLE_MESSAGE_MAX_MESSAGES ||
          (sizing.bytes ?? 0) > MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES)
      ) {
        throw new Error("Archived transcript candidates exceed the bounded read size.");
      }
      const archives = executeSqliteQuerySync(
        database.db,
        archiveQuery.select(["session_id", "generation", "archive_sha256"]),
      ).rows;
      const selectionBudget = { remainingBytes: MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES };
      for (const archive of archives) {
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          getNodeSqliteKysely<ArchiveDatabase>(database.db)
            .selectFrom("session_transcript_archives")
            .select(["archive_blob", "encoding"])
            .where("session_key", "=", plan.sessionKey)
            .where("session_id", "=", archive.session_id)
            .where("generation", "=", archive.generation),
        );
        if (!row || hashSessionArchiveBytes(row.archive_blob) !== archive.archive_sha256) {
          throw new Error("Archived transcript bytes do not match their registered hash.");
        }
        const binding = {
          sessionId: archive.session_id,
          generation: archive.generation,
          sha256: archive.archive_sha256,
        };
        const entries: Array<TranscriptArchivePageResult["entries"][number] & { bytes: number }> =
          [];
        await withTranscriptArchiveSelection(async (selection) => {
          const sessionStartedAt = await scanArchivedTranscript(
            row.archive_blob,
            row.encoding === "zstd",
            archive.session_id,
            (event, seq) => {
              if (!isRecord(event)) {
                return;
              }
              const ownsRun =
                (readSessionTranscriptRunId(event.message) ??
                  readSessionTranscriptFailureRunId(event)) === plan.runId;
              const record: Record<string, unknown> = {};
              for (const key of [
                "type",
                "id",
                "parentId",
                "targetId",
                "appendParentId",
                "appendMode",
                "firstKeptEntryId",
              ]) {
                if (Object.hasOwn(event, key)) {
                  const value = event[key];
                  // Invalid presence must not become an absent parent or a default leaf field.
                  record[key] = typeof value === "string" || value === null ? value : false;
                }
              }
              selection.append(record, seq, ownsRun);
            },
            selectionBudget,
            MAX_TASK_ARCHIVE_RECORD_BYTES,
          );
          foundRun ||= selection.hasRun;
          if (!selection.select()) {
            return;
          }
          if (result) {
            throw new Error("Multiple archived transcript generations contain this run.");
          }
          if (expectedBinding && !sameArchiveBinding(expectedBinding, binding)) {
            throw new Error("Archived transcript identity changed.");
          }
          if (plan.verifyBinding) {
            result = { binding, entries: [], totalMessages: 0 };
            return;
          }
          if (cursor && !selection.has(cursor.beforeSeq)) {
            throw new Error("Invalid archived transcript cursor position.");
          }
          let totalMessages = 0;
          let selectedBytes = 0;
          let hasOlder = false;
          let eligibleMessages = 0;
          let oversizedSeq: number | undefined;
          // A bounded older window preserves display state across hidden records.
          // Clear evicted references and compact occasionally instead of shifting
          // an 8,000-entry array for every row in a large archive.
          let preceding: Array<(typeof entries)[number] | undefined> = [];
          let precedingHead = 0;
          let precedingBytes = 0;
          const sourceTrue = selection.membership("coord-source-true");
          const sourceFalse = selection.membership("coord-source-false");
          const source = createBoundSessionHistorySubagentSource(
            (read) => read({ database, resolved: { agentId: plan.logicalAgentId } }),
            plan.projectionSources?.stateDatabase,
            () => plan.projectionSources?.sourceDatabases,
            {
              get: (key) => (sourceTrue.has(key) ? true : sourceFalse.has(key) ? false : undefined),
              set: (key, value) => (value ? sourceTrue : sourceFalse).add(key),
            },
          );
          const projectCoordination = createSubagentCoordinationHistoryProjection(
            {
              isSubagentSession: (key) => {
                if (!plan.projectionSources) {
                  throw new Error("Archived transcript coordination sources are unavailable.");
                }
                return source(key);
              },
              // The complete selected stream supplies preceding inputs and steers.
              isSubagentRunMessage: () => false,
            },
            {
              hiddenInputKeys: selection.membership("coord-hidden-input"),
              visibleInputKeys: selection.membership("coord-visible-input"),
              visibleSteerRunIds: selection.membership("coord-visible-steer"),
            },
          );
          const contextEntries: TranscriptArchivePageResult["entries"] = [];
          const contextMaxMessages = plan.contextMaxMessages ?? 0;
          let contextBytes = 0;
          let contextStopped = false;
          const trimPrecedingContext = (extraBytes = 0, extraMessages = 0) => {
            while (
              precedingHead < preceding.length &&
              (selectedBytes + precedingBytes + contextBytes + extraBytes > plan.maxBytes ||
                preceding.length - precedingHead + contextEntries.length + extraMessages >
                  contextMaxMessages)
            ) {
              const removed = preceding[precedingHead];
              if (!removed) {
                throw new Error("Archived transcript context is unavailable.");
              }
              precedingBytes -= removed.bytes;
              preceding[precedingHead++] = undefined;
            }
            if (precedingHead >= contextMaxMessages) {
              preceding = preceding.slice(precedingHead);
              precedingHead = 0;
            }
          };
          const filterAnnouncePairs = createPreSessionStartAnnouncePairFilter(sessionStartedAt);
          await scanArchivedTranscript(
            row.archive_blob,
            row.encoding === "zstd",
            archive.session_id,
            (event, seq) => {
              if (!selection.has(seq) || !isVisibleTranscriptRecord(event)) {
                return;
              }
              const messages = filterAnnouncePairs([projectTranscriptEntryMessage(event, seq)]);
              if (messages.length === 0) {
                return;
              }
              const [display] = projectCoordination(prepareChatHistoryRecoveryMessages(messages));
              const coordinationHidden = isRecord(display) && display.display === false;
              const visibleEntry = {
                event,
                seq,
                ...(coordinationHidden ? { coordinationHidden: true as const } : {}),
              };
              totalMessages += 1;
              if (cursor && seq >= cursor.beforeSeq) {
                if (contextStopped || contextMaxMessages === 0 || oversizedSeq !== undefined) {
                  return;
                }
                if (
                  (isRecord(event.message) && event.message.role === "user") ||
                  contextEntries.length >= contextMaxMessages
                ) {
                  contextStopped = true;
                  return;
                }
                const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
                if (selectedBytes + contextBytes + bytes > plan.maxBytes) {
                  contextStopped = true;
                  return;
                }
                // Newer recovery context takes priority over the older window.
                trimPrecedingContext(bytes, 1);
                contextEntries.push(visibleEntry);
                contextBytes += bytes;
                return;
              }
              eligibleMessages += 1;
              const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
              if (bytes > plan.maxBytes) {
                // Keep the same contiguous-suffix/omission contract as live history pages.
                entries.length = 0;
                selectedBytes = 0;
                preceding = [];
                precedingHead = 0;
                precedingBytes = 0;
                oversizedSeq = seq;
                hasOlder = eligibleMessages > 1;
                return;
              }
              if (oversizedSeq !== undefined) {
                hasOlder = true;
                oversizedSeq = undefined;
              }
              entries.push({ ...visibleEntry, bytes });
              selectedBytes += bytes;
              while (entries.length > plan.limit || selectedBytes > plan.maxBytes) {
                const removed = entries.shift()!;
                selectedBytes -= removed.bytes;
                preceding.push(removed);
                precedingBytes += removed.bytes;
                hasOlder = true;
              }
              trimPrecedingContext();
            },
            // Selection and paging each scan the archive; do not halve its readable size.
            { remainingBytes: MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES },
            MAX_TASK_ARCHIVE_RECORD_BYTES,
          );
          const olderContext = preceding.slice(precedingHead).flatMap((entry) => {
            if (!entry) {
              return [];
            }
            const { bytes: _bytes, ...record } = entry;
            return [record];
          });
          const projectionContext = [...olderContext, ...contextEntries];
          const first = entries[0];
          const beforeSeq = first?.seq ?? oversizedSeq;
          result = {
            binding,
            entries: entries.map(({ bytes: _bytes, ...entry }) => entry),
            ...(projectionContext.length > 0 ? { contextEntries: projectionContext } : {}),
            totalMessages,
            ...(oversizedSeq !== undefined ? { omittedOversized: true as const } : {}),
            ...(hasOlder && beforeSeq !== undefined
              ? {
                  nextCursor: Buffer.from(
                    JSON.stringify({
                      ...binding,
                      sessionKey: plan.sessionKey,
                      runId: plan.runId,
                      beforeSeq,
                    } satisfies ArchivePageCursor),
                    "utf8",
                  ).toString("base64url"),
                }
              : {}),
          };
        });
      }
    }
    if (!result && foundRun) {
      throw new Error("Archived transcript run is not on the active branch.");
    }
    if (!result && expectedBinding) {
      throw new Error("Archived transcript is no longer available.");
    }
    database.db.exec("COMMIT"); // sqlite-allow-raw: release the completed archive read snapshot.
    transactionOpen = false;
    return result;
  } finally {
    try {
      if (transactionOpen) {
        database.db.exec("ROLLBACK"); // sqlite-allow-raw: release a failed archive read snapshot.
      }
    } finally {
      database.close();
    }
  }
}
