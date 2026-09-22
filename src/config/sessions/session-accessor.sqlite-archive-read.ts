import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { hashSessionArchiveBytes } from "./session-accessor.sqlite-archive-artifact.js";
import type {
  TranscriptArchiveReadPlan,
  TranscriptArchiveReadResult,
} from "./session-accessor.sqlite-archive-types.js";

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
  const result: TranscriptArchiveReadResult = {};
  const scan = async (source: Readable) => {
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    const fragments: string[] = [];
    let depth = 0;
    try {
      for await (const line of lines) {
        let event: unknown;
        if (fragments.length === 0) {
          if (!line.trim()) {
            continue;
          }
          try {
            event = JSON.parse(line);
          } catch {
            // Exact SQLite imports retain multiline JSON values.
            fragments.push(line);
          }
        } else {
          fragments.push(line);
        }
        if (fragments.length > 0) {
          let quoted = false;
          let escaped = false;
          for (const character of line) {
            if (escaped) {
              escaped = false;
            } else if (quoted && character === "\\") {
              escaped = true;
            } else if (character === '"') {
              quoted = !quoted;
            } else if (!quoted) {
              if (character === "{" || character === "[") {
                depth += 1;
              } else if (character === "}" || character === "]") {
                depth -= 1;
              }
            }
          }
          // JSON strings cannot cross physical lines; parse now to reject the invalid value.
          if (!quoted && depth > 0) {
            continue;
          }
          event = JSON.parse(fragments.join("\n"));
          fragments.length = 0;
        }
        if (!headerRead) {
          if (!isRecord(event) || event.type !== "session" || event.id !== sessionId) {
            throw new Error("Archived transcript header does not match its registered session.");
          }
          headerRead = true;
        } else if (isVisibleSubagentResultEventForRun(event, runId)) {
          result.event = event;
        }
      }
      if (fragments.length > 0) {
        throw new SyntaxError("Unterminated archived transcript JSON.");
      }
    } finally {
      lines.close();
    }
  };
  if (compressed && createZstdDecompress) {
    await pipeline(input, createZstdDecompress.call(zlib), scan);
  } else {
    await pipeline(input, scan);
  }
  if (!headerRead) {
    throw new Error("Archived transcript header does not match its registered session.");
  }
  return result;
}
