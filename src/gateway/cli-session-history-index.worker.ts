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
import {
  compareCliHistoryRows,
  createCliHistoryRow,
  DEDUPE_TIMESTAMP_WINDOW_MS,
  mergeCliHistoryRow,
  type CliHistoryMergeStore,
  type HistoryMatch,
  type HistoryRow,
  type HistoryTextMatch,
} from "./cli-session-history-index-policy.js";

const INDEX_INSERT_BATCH_ROWS = 65;
const INDEX_ORDINAL_BATCH_ROWS = 256;
const INDEX_INSERT_BATCH_BYTES = 1024 * 1024;

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

  constructor() {
    this.database = openNodeSqliteDatabase("");
    this.db = getNodeSqliteKysely<HistoryDatabase>(this.database);
    // Only imported bodies live here; local rows retain their canonical sequence.
    const columns = `id INTEGER PRIMARY KEY, local_seq INTEGER, import_ref INTEGER, message_id TEXT, payload TEXT, bytes INTEGER NOT NULL, role TEXT,
      text TEXT, undecorated_text TEXT, routed_key TEXT, timestamp REAL, external_key TEXT, image_key TEXT,
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
      CREATE INDEX match_routed ON messages(role, routed_key, consumed, id);
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
        undecorated_text: parameter((row) => row.undecorated_text),
        routed_key: parameter((row) => row.routed_key),
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

  appendLocal(messages: readonly { message: unknown; seq: number }[]): void {
    for (let offset = 0; offset < messages.length; offset += INDEX_INSERT_BATCH_ROWS) {
      const rows = messages
        .slice(offset, offset + INDEX_INSERT_BATCH_ROWS)
        .map(({ message, seq }) => {
          const id = seq - 1;
          this.nextLocal = Math.max(this.nextLocal, id + 1);
          return createCliHistoryRow(message, id, seq);
        });
      runSqliteImmediateTransactionSync(this.database, () => {
        for (const row of rows) {
          this.insertMessage(row);
        }
      });
    }
  }

  appendImported(message: unknown): void {
    const row = createCliHistoryRow(message, this.nextImport++);
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
    const candidates = () =>
      this.db.selectFrom("messages").select(["id", "text", "routed_key", "metadata"]);
    const matchExternal = prepareSqliteQueryTakeFirstSync<string, HistoryMatch>(
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
    const matchImage = prepareSqliteQueryTakeFirstSync<string, HistoryMatch>(
      this.database,
      (parameter) =>
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
    const textMatchers = (external: boolean, column: "text" | "routed_key") => {
      const create = (time: "any" | "window" | "missing") =>
        prepareSqliteQueryTakeFirstSync<HistoryTextMatch, HistoryMatch>(
          this.database,
          (parameter) => {
            let query = candidates()
              .where(
                "role",
                "=",
                parameter((row) => row.role),
              )
              .where(
                column,
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
          },
        );
      return { any: create("any"), window: create("window"), missing: create("missing") };
    };
    const matchers = {
      text: {
        withIdentity: textMatchers(true, "text"),
        withoutIdentity: textMatchers(false, "text"),
      },
      routed_key: {
        withIdentity: textMatchers(true, "routed_key"),
        withoutIdentity: textMatchers(false, "routed_key"),
      },
    };
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
    const store: CliHistoryMergeStore = {
      matchExternal,
      matchImage,
      matchers,
      consume,
      minimumOrder: (role, text) =>
        this.readOrderFloor({ role: role ?? "", text })?.minimum_order ?? 0,
      advanceOrderFloor: (floor) => {
        this.advanceOrderFloor(floor);
      },
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
            "undecorated_text",
            "routed_key",
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
          if (!mergeCliHistoryRow(imported, store)) {
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
      order.sort(compareCliHistoryRows);
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
