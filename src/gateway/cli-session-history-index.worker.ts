import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  hashCliImageTurnEntryId,
  readCliImageTurnContext,
} from "../agents/cli-image-turn-correlation.js";
import { stripCliSessionDriftNote } from "../agents/cli-session.js";
import { isOpenClawCliImageCachePath } from "../agents/embedded-agent-runner/run/images.media-refs.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

const INDEX_INSERT_BATCH_ROWS = 65;
const INDEX_ORDINAL_BATCH_ROWS = 256;
const INDEX_INSERT_BATCH_BYTES = 1024 * 1024;

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

// Claude records CLI-injected @cache-path suffixes as user text. Keep the
// stored content intact; this normalized view is only for proving a redundant
// imported row against the local turn that owns the durable media facts.
function stripTrailingCliImageMentions(text: string): {
  text: string;
  stripped: boolean;
} {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? "";
    if (!line.startsWith("@") || !isOpenClawCliImageCachePath(line.slice(1))) {
      break;
    }
    end -= 1;
  }
  return end === lines.length
    ? { text, stripped: false }
    : { text: lines.slice(0, end).join("\n").trimEnd(), stripped: true };
}

function extractComparableText(
  record: Record<string, unknown>,
  role: string | undefined,
): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
  driftNoteText?: string;
} {
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const rawContent = record.content;
  const content = readStringValue(rawContent);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return { hasCliImageMentions: false };
  }
  const rawText = parts.join("\n");
  const joined = rawText.trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const meta = asOptionalRecord(record["__openclaw"]);
  const isClaudeImport =
    role === "user" && normalizeOptionalString(meta?.importedFrom) === "claude-cli";
  const stripResult = isClaudeImport
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const normalizeText = (value: string) => {
    const visible = stripInlineDirectiveTagsForDisplay(
      role === "user" ? stripInboundMetadata(value) : value,
    ).text;
    return visible.replace(/\s+/g, " ").trim();
  };
  const normalized = normalizeText(stripResult.text);
  const withoutDriftNote = isClaudeImport ? stripCliSessionDriftNote(rawText) : rawText;
  const driftNoteText =
    withoutDriftNote !== rawText
      ? normalizeText(stripTrailingCliImageMentions(withoutDriftNote.trim()).text)
      : undefined;
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && isClaudeImport
      ? { cliImageTurnKey: storedImageTurnKey ?? readCliImageTurnContext(joined) }
      : {}),
    ...(normalized ? { text: normalized } : {}),
    ...(driftNoteText ? { driftNoteText } : {}),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString(meta?.importedFrom),
        normalizeOptionalString(meta?.cliSessionId),
      ])
    : undefined;
}

type HistoryRow = {
  id: number;
  local_seq: number | null;
  import_ref: number | null;
  message_id: string | null;
  payload: string | null;
  bytes: number;
  role: string | null;
  text: string | null;
  drift_text: string | null;
  timestamp: number | null;
  external_key: string | null;
  image_key: string | null;
  image_mentions: number;
  metadata: string | null;
  consumed: number;
  ordinal: number | null;
};
type HistoryDatabase = {
  messages: HistoryRow;
  imports: HistoryRow;
  floors: { role: string; text: string; minimum_order: number };
};

/** Reconstructible display index; canonical transcript bytes are never changed. */
export class CliSessionHistoryIndex {
  private readonly database;
  private readonly db;
  private readonly insertMessage;
  private readonly insertImport;
  private readonly assignOrdinal;
  private readonly readOrderFloor;
  private readonly advanceOrderFloor;
  private readonly pendingImports: HistoryRow[] = [];
  private pendingImportBytes = 0;
  private nextLocal = 0;
  private nextImport = 0;
  private expanded = false;
  count = 0;

  constructor(memoryOnly = false) {
    this.database = openNodeSqliteDatabase(memoryOnly ? ":memory:" : "");
    this.db = getNodeSqliteKysely<HistoryDatabase>(this.database);
    // Only imported bodies live here; local rows retain their canonical sequence.
    const columns = `id INTEGER PRIMARY KEY, local_seq INTEGER, import_ref INTEGER, message_id TEXT, payload TEXT, bytes INTEGER NOT NULL, role TEXT,
      text TEXT, drift_text TEXT, timestamp REAL, external_key TEXT, image_key TEXT,
      image_mentions INTEGER NOT NULL, metadata TEXT, consumed INTEGER NOT NULL,
      ordinal INTEGER`;
    // sqlite-allow-raw -- Reconstructible temporary schema; no canonical writes or durability.
    this.database
      .exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -2048;
      CREATE TABLE messages (${columns}); CREATE TABLE imports (${columns});
      CREATE TABLE floors (role TEXT NOT NULL, text TEXT NOT NULL, minimum_order INTEGER NOT NULL, PRIMARY KEY(role,text));
      CREATE INDEX match_external ON messages(external_key, id);
      CREATE INDEX match_text ON messages(role, text, consumed, id);
      CREATE INDEX match_timed_text ON messages(role, text, consumed, id) WHERE timestamp IS NOT NULL;
      CREATE INDEX match_undated_text ON messages(role, text, consumed, id) WHERE timestamp IS NULL;
      CREATE INDEX match_image ON messages(image_key, consumed, id);
      CREATE INDEX message_identity ON messages(message_id);
      CREATE INDEX local_sequence ON messages(local_seq);
      CREATE UNIQUE INDEX history_ordinal ON messages(ordinal);`);
    enableNodeSqliteKyselyStatementCache(this.database);
    this.insertMessage = this.createInserter("messages");
    this.insertImport = this.createInserter("imports");
    this.readOrderFloor = prepareSqliteQueryTakeFirstSync<
      { role: string; text: string },
      { minimum_order: number }
    >(this.database, (parameter) =>
      this.db
        .selectFrom("floors")
        .select("minimum_order")
        .where(
          "role",
          "=",
          parameter((row) => row.role),
        )
        .where(
          "text",
          "=",
          parameter((row) => row.text),
        ),
    );
    this.advanceOrderFloor = prepareSqliteQuerySync<{
      role: string;
      text: string;
      minimumOrder: number;
    }>(this.database, (parameter) =>
      this.db
        .insertInto("floors")
        .values({
          role: parameter((row) => row.role),
          text: parameter((row) => row.text),
          minimum_order: parameter((row) => row.minimumOrder),
        })
        .onConflict((conflict) =>
          conflict.columns(["role", "text"]).doUpdateSet((eb) => ({
            minimum_order: eb.fn<number>("max", [
              eb.ref("floors.minimum_order"),
              eb.ref("excluded.minimum_order"),
            ]),
          })),
        ),
    );
    this.assignOrdinal = prepareSqliteQuerySync<{ id: number; ordinal: number }>(
      this.database,
      (parameter) =>
        this.db
          .updateTable("messages")
          .set({ ordinal: parameter((row) => row.ordinal) })
          .where(
            "id",
            "=",
            parameter((row) => row.id),
          ),
    );
  }

  private createInserter(table: "messages" | "imports") {
    return prepareSqliteQuerySync<HistoryRow>(this.database, (parameter) => {
      const query = this.db.insertInto(table).values({
        id: parameter((row) => row.id),
        local_seq: parameter((row) => row.local_seq),
        import_ref: parameter((row) => row.import_ref),
        message_id: parameter((row) => row.message_id),
        payload: parameter((row) => row.payload),
        bytes: parameter((row) => row.bytes),
        role: parameter((row) => row.role),
        text: parameter((row) => row.text),
        drift_text: parameter((row) => row.drift_text),
        timestamp: parameter((row) => row.timestamp),
        external_key: parameter((row) => row.external_key),
        image_key: parameter((row) => row.image_key),
        image_mentions: parameter((row) => row.image_mentions),
        metadata: parameter((row) => row.metadata),
        consumed: parameter((row) => row.consumed),
        ordinal: parameter((row) => row.ordinal),
      });
      return table === "messages"
        ? query.onConflict((conflict) => conflict.column("id").doNothing())
        : query;
    });
  }

  close(): void {
    this.pendingImports.length = 0;
    this.database.close();
  }

  private row(message: unknown, id: number, localSeq?: number): HistoryRow {
    const record = asOptionalRecord(message);
    const meta = asOptionalRecord(record?.["__openclaw"]);
    const role = record?.role === "user" || record?.role === "assistant" ? record.role : undefined;
    const comparable: ReturnType<typeof extractComparableText> =
      record && role ? extractComparableText(record, role) : { hasCliImageMentions: false };
    const localImage =
      record?.role === "user" && (readPersistedMediaFacts(record) ?? []).some(isImageMediaFact);
    const entryId = normalizeOptionalString(meta?.id);
    const serialized = JSON.stringify(message);
    return {
      id,
      local_seq: localSeq ?? null,
      import_ref: null,
      message_id: entryId === undefined ? null : JSON.stringify(entryId),
      payload: localSeq === undefined ? serialized : null,
      bytes: Buffer.byteLength(serialized, "utf8"),
      role: role ?? null,
      text: comparable.text === undefined ? null : JSON.stringify(comparable.text),
      drift_text:
        comparable.driftNoteText === undefined ? null : JSON.stringify(comparable.driftNoteText),
      timestamp: asFiniteNumber(record?.timestamp) ?? null,
      external_key: resolveImportedExternalIdentityKey(meta) ?? null,
      image_key:
        localSeq === undefined
          ? (comparable.cliImageTurnKey ?? null)
          : localImage
            ? ((entryId ? hashCliImageTurnEntryId(entryId) : comparable.cliImageTurnKey) ?? null)
            : null,
      image_mentions: comparable.hasCliImageMentions ? 1 : 0,
      metadata: meta ? JSON.stringify(meta) : null,
      consumed: 0,
      ordinal: null,
    };
  }

  appendLocal(messages: readonly { message: unknown; seq: number }[]): void {
    for (let offset = 0; offset < messages.length; offset += INDEX_INSERT_BATCH_ROWS) {
      const rows = messages
        .slice(offset, offset + INDEX_INSERT_BATCH_ROWS)
        .map(({ message, seq }) => {
          const id = seq - 1;
          this.nextLocal = Math.max(this.nextLocal, id + 1);
          return this.row(message, id, seq);
        });
      runSqliteImmediateTransactionSync(this.database, () => {
        for (const row of rows) {
          this.insertMessage(row);
        }
      });
    }
  }

  appendImported(message: unknown): void {
    const row = this.row(message, this.nextImport++);
    if (this.pendingImportBytes + row.bytes > INDEX_INSERT_BATCH_BYTES) {
      this.flushImports();
    }
    this.pendingImports.push(row);
    this.pendingImportBytes += row.bytes;
    if (this.pendingImports.length >= INDEX_INSERT_BATCH_ROWS) {
      this.flushImports();
    }
  }

  private flushImports(): void {
    if (!this.pendingImports.length) {
      return;
    }
    runSqliteImmediateTransactionSync(this.database, () => {
      for (const row of this.pendingImports) {
        this.insertImport(row);
      }
    });
    this.pendingImports.length = 0;
    this.pendingImportBytes = 0;
  }

  finish(): void {
    this.flushImports();
    // Reserve every existing external identity before text matching can consume it.
    executeSqliteQuerySync(
      this.database,
      this.db
        .updateTable("messages")
        .set({ consumed: 1 })
        .where(
          "id",
          "in",
          this.db
            .selectFrom("messages")
            .select(({ fn }) => fn.max<number>("id").as("id"))
            .where(
              "external_key",
              "in",
              this.db
                .selectFrom("imports")
                .select("external_key")
                .where("external_key", "is not", null),
            )
            .groupBy("external_key"),
        ),
    );
    type Match = Pick<HistoryRow, "id" | "text" | "metadata">;
    const candidates = () => this.db.selectFrom("messages").select(["id", "text", "metadata"]);
    const matchExternal = prepareSqliteQueryTakeFirstSync<string, Match>(
      this.database,
      (parameter) =>
        candidates()
          .where(
            "external_key",
            "=",
            parameter((key) => key),
          )
          .orderBy("id", "desc")
          .limit(1),
    );
    const matchImage = prepareSqliteQueryTakeFirstSync<string, Match>(this.database, (parameter) =>
      candidates()
        .where(
          "image_key",
          "=",
          parameter((key) => key),
        )
        .where("local_seq", "is not", null)
        .where("consumed", "=", 0)
        .orderBy("id")
        .limit(1),
    );
    type TextMatch = { role: string; text: string; floor: number; timestamp: number | null };
    const textMatchers = (external: boolean) => {
      const create = (time: "any" | "window" | "missing") =>
        prepareSqliteQueryTakeFirstSync<TextMatch, Match>(this.database, (parameter) => {
          let query = candidates()
            .where(
              "role",
              "=",
              parameter((row) => row.role),
            )
            .where(
              "text",
              "=",
              parameter((row) => row.text),
            )
            .where("consumed", "=", 0)
            .where(
              "id",
              ">=",
              parameter((row) => row.floor),
            )
            .orderBy("id")
            .limit(1);
          if (external) {
            query = query.where("external_key", "is", null);
          }
          if (time === "window") {
            query = query
              .where(
                "timestamp",
                ">=",
                parameter((row) => (row.timestamp ?? 0) - DEDUPE_TIMESTAMP_WINDOW_MS),
              )
              .where(
                "timestamp",
                "<=",
                parameter((row) => (row.timestamp ?? 0) + DEDUPE_TIMESTAMP_WINDOW_MS),
              );
          } else if (time === "missing") {
            query = query.where("timestamp", "is", null);
          }
          return query;
        });
      return { any: create("any"), window: create("window"), missing: create("missing") };
    };
    const withIdentity = textMatchers(true);
    const withoutIdentity = textMatchers(false);
    const consume = prepareSqliteQuerySync<Pick<HistoryRow, "id" | "metadata" | "external_key">>(
      this.database,
      (parameter) =>
        this.db
          .updateTable("messages")
          .set({
            metadata: parameter((row) => row.metadata),
            consumed: 1,
            external_key: parameter((row) => row.external_key),
          })
          .where(
            "id",
            "=",
            parameter((row) => row.id),
          ),
    );
    const minimumOrder = (role: string | null, text: string) =>
      this.readOrderFloor({ role: role ?? "", text })?.minimum_order ?? 0;
    const advance = (
      imported: Pick<HistoryRow, "role" | "text" | "drift_text">,
      matched: Pick<HistoryRow, "id" | "text">,
    ) => {
      for (const text of new Set([
        imported.text,
        matched.text === imported.text ? imported.text : imported.drift_text,
      ])) {
        if (text) {
          this.advanceOrderFloor({ role: imported.role ?? "", text, minimumOrder: matched.id + 1 });
        }
      }
    };
    for (let offset = 0; offset < this.nextImport; offset += INDEX_INSERT_BATCH_ROWS) {
      const batch = executeSqliteQuerySync(
        this.database,
        this.db
          .selectFrom("imports")
          .select([
            "id",
            "local_seq",
            "import_ref",
            "message_id",
            "bytes",
            "role",
            "text",
            "drift_text",
            "timestamp",
            "external_key",
            "image_key",
            "image_mentions",
            "metadata",
            "consumed",
            "ordinal",
          ])
          .where("id", ">=", offset)
          .orderBy("id")
          .limit(INDEX_INSERT_BATCH_ROWS),
      ).rows;
      runSqliteImmediateTransactionSync(this.database, () => {
        for (const imported of batch) {
          let duplicate = imported.external_key ? matchExternal(imported.external_key) : undefined;
          if (duplicate) {
            advance(imported, duplicate);
            continue;
          }
          if (imported.image_mentions && imported.image_key) {
            duplicate = matchImage(imported.image_key);
          }
          if (!duplicate && !imported.image_mentions) {
            const importedFloor = imported.text ? minimumOrder(imported.role, imported.text) : 0;
            for (const text of [imported.text, imported.drift_text]) {
              if (!text || !imported.role) {
                continue;
              }
              const floor =
                text === imported.text
                  ? importedFloor
                  : Math.max(minimumOrder(imported.role, text), importedFloor);
              const match = imported.external_key ? withIdentity : withoutIdentity;
              const params = { role: imported.role, text, floor, timestamp: imported.timestamp };
              duplicate =
                imported.timestamp === null
                  ? match.any(params)
                  : (match.window(params) ?? match.missing(params));
              if (duplicate) {
                break;
              }
            }
          }
          if (duplicate) {
            const meta: Record<string, unknown> = duplicate.metadata
              ? JSON.parse(duplicate.metadata)
              : {};
            const importedMeta: Record<string, unknown> = imported.metadata
              ? JSON.parse(imported.metadata)
              : {};
            let metadataChanged = false;
            for (const field of ["importedFrom", "externalId", "cliSessionId"]) {
              const value = normalizeOptionalString(importedMeta[field]);
              if (value && meta[field] === undefined) {
                meta[field] = value;
                metadataChanged = true;
              }
            }
            consume({
              id: duplicate.id,
              metadata: metadataChanged ? JSON.stringify(meta) : duplicate.metadata,
              external_key: resolveImportedExternalIdentityKey(meta) ?? null,
            });
            advance(imported, duplicate);
          } else {
            this.insertMessage({
              ...imported,
              id: this.nextLocal++,
              payload: null,
              import_ref: imported.id,
              consumed: 1,
            });
            this.expanded = true;
          }
        }
      });
    }
    // Preserve the existing stable comparator even for mixed/missing timestamps.
    const order = executeSqliteQuerySync(
      this.database,
      this.db.selectFrom("messages").select(["id", "timestamp"]).orderBy("id"),
    ).rows;
    if (this.expanded) {
      order.sort((a, b) =>
        a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp
          ? a.timestamp - b.timestamp
          : a.id - b.id,
      );
    }
    for (let offset = 0; offset < order.length; offset += INDEX_ORDINAL_BATCH_ROWS) {
      const end = Math.min(order.length, offset + INDEX_ORDINAL_BATCH_ROWS);
      runSqliteImmediateTransactionSync(this.database, () => {
        for (let ordinal = offset; ordinal < end; ordinal++) {
          this.assignOrdinal({ id: order[ordinal]!.id, ordinal });
        }
      });
    }
    this.count = order.length;
  }

  get importedCount(): number {
    return this.nextImport;
  }

  rows(start: number, end: number) {
    return executeSqliteQuerySync(
      this.database,
      this.db
        .selectFrom("messages")
        .select(["id", "local_seq", "metadata", "ordinal", "bytes"])
        .where("ordinal", ">=", start)
        .where("ordinal", "<", end)
        .orderBy("ordinal"),
    ).rows;
  }

  message(id: number): unknown {
    const row = executeSqliteQueryTakeFirstSync(
      this.database,
      this.db
        .selectFrom("messages")
        .innerJoin("imports", "imports.id", "messages.import_ref")
        .select("imports.payload")
        .where("messages.id", "=", id),
    );
    return row?.payload ? JSON.parse(row.payload) : undefined;
  }

  localOrdinal(seq: number): number | undefined {
    return (
      executeSqliteQueryTakeFirstSync(
        this.database,
        this.db.selectFrom("messages").select("ordinal").where("local_seq", "=", seq),
      )?.ordinal ?? undefined
    );
  }

  ordinal(messageId: string): number | undefined {
    return (
      executeSqliteQueryTakeFirstSync(
        this.database,
        this.db
          .selectFrom("messages")
          .select("ordinal")
          .where("message_id", "=", JSON.stringify(messageId))
          .orderBy("ordinal")
          .limit(1),
      )?.ordinal ?? undefined
    );
  }
}
