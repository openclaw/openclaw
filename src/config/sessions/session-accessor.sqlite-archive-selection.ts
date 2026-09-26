// Disposable navigation scratch belongs to the archive worker, never canonical session state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  prepareSqliteQueryIterator,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createPrivateSqliteTempDirectorySync } from "../../infra/sqlite-private-directory.js";
import {
  scanSessionTranscriptNavigation,
  selectSessionTranscriptActiveEntryIndexes,
  visitSessionTranscriptTreePathNodes,
  type SessionTranscriptTreeNode,
} from "./transcript-tree.js";

type Record = { [key: string]: unknown };
type Node = SessionTranscriptTreeNode<Record>;
type SelectionDatabase = {
  records: { idx: number; seq: number; record_json: string; owns_run: number };
  nodes: { id: string; node_json: string };
  sets: { kind: string; id: string };
  paths: { kind: string; position: number; node_json: string };
  selected: { seq: number; owns_run: number };
};

export async function withTranscriptArchiveSelection<T>(
  run: (selection: TranscriptArchiveSelection) => Promise<T>,
): Promise<T> {
  const directory = createPrivateSqliteTempDirectorySync(
    os.tmpdir(),
    "openclaw-archive-selection-",
  );
  let database: DatabaseSync | undefined;
  try {
    const filename = path.join(directory, "navigation.sqlite");
    fs.closeSync(fs.openSync(filename, "wx", 0o600));
    database = openNodeSqliteDatabase(filename);
    // This private, disposable spool has no durability contract. Bound the page cache
    // and spill sort work to disk instead of moving unbounded JS objects to native heap.
    // sqlite-allow-raw: fixed scratch schema and connection pragmas; ordinary queries use Kysely.
    database.exec(`
      PRAGMA cache_size = -2048;
      PRAGMA temp_store = FILE;
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE records (idx INTEGER PRIMARY KEY, seq INTEGER NOT NULL, record_json TEXT NOT NULL, owns_run INTEGER NOT NULL);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, node_json TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE sets (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind, id)) WITHOUT ROWID;
      CREATE TABLE paths (kind TEXT NOT NULL, position INTEGER NOT NULL, node_json TEXT NOT NULL, PRIMARY KEY(kind, position)) WITHOUT ROWID;
      CREATE TABLE selected (seq INTEGER PRIMARY KEY, owns_run INTEGER NOT NULL);
    `);
    enableNodeSqliteKyselyStatementCache(database);
    return await run(new TranscriptArchiveSelection(database));
  } finally {
    try {
      database?.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

class TranscriptArchiveSelection {
  private readonly insert;
  private readonly readRecord;
  private readonly contains;
  private readonly insertMembership;
  private readonly hasMembership;
  private readonly pendingMemberships = new Map<string, SelectionDatabase["sets"]>();
  private pendingMembershipBytes = 0;
  private membershipRevision = 0;
  private pending: Array<{ seq: number; json: string; ownsRun: boolean }> = [];
  private pendingBytes = 0;
  private count = 0;
  hasRun = false;

  constructor(private readonly database: DatabaseSync) {
    const db = getNodeSqliteKysely<SelectionDatabase>(database);
    this.insertMembership = prepareSqliteQuerySync<SelectionDatabase["sets"]>(
      database,
      (parameter) =>
        db
          .insertInto("sets")
          .orIgnore()
          .values({
            kind: parameter((row) => row.kind),
            id: parameter((row) => row.id),
          }),
    );
    this.hasMembership = prepareSqliteQueryTakeFirstSync<SelectionDatabase["sets"], { id: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("sets")
          .select("id")
          .where(
            "kind",
            "=",
            parameter((row) => row.kind),
          )
          .where(
            "id",
            "=",
            parameter((row) => row.id),
          ),
    );
    this.insert = prepareSqliteQuerySync<SelectionDatabase["records"]>(database, (parameter) =>
      db.insertInto("records").values({
        idx: parameter((row) => row.idx),
        seq: parameter((row) => row.seq),
        record_json: parameter((row) => row.record_json),
        owns_run: parameter((row) => row.owns_run),
      }),
    );
    this.readRecord = prepareSqliteQueryTakeFirstSync<number, { record_json: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("records")
          .select("record_json")
          .where(
            "idx",
            "=",
            parameter((index) => index),
          ),
    );
    this.contains = prepareSqliteQueryTakeFirstSync<number, { seq: number }>(
      database,
      (parameter) =>
        db
          .selectFrom("selected")
          .select("seq")
          .where(
            "seq",
            "=",
            parameter((seq) => seq),
          ),
    );
  }

  append(record: Record, seq: number, ownsRun: boolean): void {
    const json = JSON.stringify(record);
    this.pending.push({ seq, json, ownsRun });
    this.pendingBytes += Buffer.byteLength(json);
    this.hasRun ||= ownsRun;
    if (this.pending.length >= 1024 || this.pendingBytes >= 1024 * 1024) {
      this.flush();
    }
  }

  private transaction(run: () => void): void {
    this.database.exec("BEGIN");
    try {
      run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private flush(): void {
    this.transaction(() => {
      for (const entry of this.pending) {
        this.insert({
          idx: this.count++,
          seq: entry.seq,
          record_json: entry.json,
          owns_run: entry.ownsRun ? 1 : 0,
        });
      }
    });
    this.pending = [];
    this.pendingBytes = 0;
  }

  select(): boolean {
    this.flush();
    if (!this.hasRun) {
      return false;
    }
    this.transaction(() => this.selectActiveEntries());
    return (
      executeSqliteQueryTakeFirstSync(
        this.database,
        getNodeSqliteKysely<SelectionDatabase>(this.database)
          .selectFrom("selected")
          .select("seq")
          .where("owns_run", "=", 1)
          .limit(1),
      ) !== undefined
    );
  }

  has(seq: number): boolean {
    return this.contains(seq) !== undefined;
  }

  membership(kind: string) {
    let cachedId: string | undefined;
    let cachedRevision = -1;
    let cachedResult = false;
    return {
      has: (id: string) => {
        if (cachedId === id && cachedRevision === this.membershipRevision) {
          return cachedResult;
        }
        const result =
          this.pendingMemberships.has(JSON.stringify([kind, id])) ||
          this.hasMembership({ kind, id }) !== undefined;
        cachedId = id;
        cachedRevision = this.membershipRevision;
        cachedResult = result;
        return result;
      },
      add: (id: string) => {
        const key = JSON.stringify([kind, id]);
        if (this.pendingMemberships.has(key)) {
          return;
        }
        this.pendingMemberships.set(key, { kind, id });
        // One retained lookup per handle; every addition invalidates all handles.
        this.membershipRevision += 1;
        this.pendingMembershipBytes += Buffer.byteLength(key);
        if (this.pendingMemberships.size >= 1024 || this.pendingMembershipBytes >= 1024 * 1024) {
          this.transaction(() => {
            for (const row of this.pendingMemberships.values()) {
              this.insertMembership(row);
            }
          });
          this.pendingMemberships.clear();
          this.pendingMembershipBytes = 0;
        }
      },
    };
  }

  private selectActiveEntries(): void {
    const database = this.database;
    const db = getNodeSqliteKysely<SelectionDatabase>(database);
    const putNode = prepareSqliteQuerySync<{ id: string; node: Node }>(database, (parameter) =>
      db
        .insertInto("nodes")
        .orReplace()
        .values({
          id: parameter((row) => row.id),
          node_json: parameter((row) => JSON.stringify(row.node)),
        }),
    );
    const getNode = prepareSqliteQueryTakeFirstSync<string, { node_json: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("nodes")
          .select("node_json")
          .where(
            "id",
            "=",
            parameter((id) => id),
          ),
    );
    const hasNode = prepareSqliteQueryTakeFirstSync<string, { id: string }>(database, (parameter) =>
      db
        .selectFrom("nodes")
        .select("id")
        .where(
          "id",
          "=",
          parameter((id) => id),
        ),
    );
    const byId = {
      get: (id: string): Node | undefined => {
        const row = getNode(id);
        // SAFETY: only the typed navigation scanner writes this private scratch table.
        return row ? (JSON.parse(row.node_json) as Node) : undefined;
      },
      has: (id: string) => hasNode(id) !== undefined,
      set: (id: string, node: Node) => {
        putNode({ id, node });
      },
    };
    const putSet = prepareSqliteQuerySync<SelectionDatabase["sets"]>(database, (parameter) =>
      db
        .insertInto("sets")
        .orIgnore()
        .values({ kind: parameter((row) => row.kind), id: parameter((row) => row.id) }),
    );
    const hasSet = prepareSqliteQueryTakeFirstSync<SelectionDatabase["sets"], { id: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("sets")
          .select("id")
          .where(
            "kind",
            "=",
            parameter((row) => row.kind),
          )
          .where(
            "id",
            "=",
            parameter((row) => row.id),
          ),
    );
    const clearSet = prepareSqliteQuerySync<string>(database, (parameter) =>
      db.deleteFrom("sets").where(
        "kind",
        "=",
        parameter((kind) => kind),
      ),
    );
    const diskSet = (kind: string) => ({
      add: (id: string) => {
        putSet({ kind, id });
      },
      has: (id: string) => hasSet({ kind, id }) !== undefined,
      clear: () => {
        clearSet(kind);
      },
    });
    function* records(): Generator<Record> {
      for (const row of iterateSqliteQuerySync(
        database,
        db.selectFrom("records").select("record_json").orderBy("idx"),
      )) {
        // SAFETY: append serialized the navigation projection without transforming its fields.
        yield JSON.parse(row.record_json) as Record;
      }
    }
    const tree = scanSessionTranscriptNavigation(records(), {
      byId,
      addNode: () => {},
      resetDescendantIds: diskSet("reset"),
      invalidLeafControlIds: diskSet("invalid"),
    });
    if (tree.hasInvalidLeafControl) {
      throw new Error("Archived transcript contains an invalid branch selection.");
    }
    const putPath = prepareSqliteQuerySync<SelectionDatabase["paths"]>(database, (parameter) =>
      db.insertInto("paths").values({
        kind: parameter((row) => row.kind),
        position: parameter((row) => row.position),
        node_json: parameter((row) => row.node_json),
      }),
    );
    const clearPath = prepareSqliteQuerySync<string>(database, (parameter) =>
      db.deleteFrom("paths").where(
        "kind",
        "=",
        parameter((kind) => kind),
      ),
    );
    const getPath = prepareSqliteQueryIterator<string, { node_json: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("paths")
          .select("node_json")
          .where(
            "kind",
            "=",
            parameter((kind) => kind),
          )
          .orderBy("position", "desc"),
    );
    const paths = new Map<string | null, string>();
    const readPath = (leafId: string | null): Iterable<Node> => {
      let kind = paths.get(leafId);
      if (kind === undefined) {
        const pathKind = String(paths.size);
        kind = pathKind;
        paths.set(leafId, pathKind);
        const seen = diskSet("walk");
        seen.clear();
        let position = 0;
        const valid = visitSessionTranscriptTreePathNodes(byId, leafId, seen, (node) => {
          putPath({ kind: pathKind, position: position++, node_json: JSON.stringify(node) });
        });
        if (!valid) {
          clearPath(kind);
        }
      }
      const selectedKind = kind;
      return {
        *[Symbol.iterator]() {
          for (const row of getPath(selectedKind)) {
            // SAFETY: paths contains only nodes supplied by the shared tree walker.
            yield JSON.parse(row.node_json) as Node;
          }
        },
      };
    };
    const select = prepareSqliteQuerySync<number>(database, (parameter) =>
      db
        .insertInto("selected")
        .orIgnore()
        .columns(["seq", "owns_run"])
        .expression(
          db
            .selectFrom("records")
            .select(["seq", "owns_run"])
            .where(
              "idx",
              "=",
              parameter((index) => index),
            ),
        ),
    );
    for (const index of selectSessionTranscriptActiveEntryIndexes({
      tree,
      entryCount: this.count,
      recordAt: (recordIndex) => {
        const row = this.readRecord(recordIndex);
        return row ? JSON.parse(row.record_json) : undefined;
      },
      readPath,
    })) {
      select(index);
    }
  }
}
