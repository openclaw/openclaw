import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier } from "./sqlite-schema-sql.js";

/** Simulate the other side of SQLite 3.54's U+FFFE tokenizer change on either runtime. */
export function installSqliteFtsTokenizerMismatch(pathname: string, table: string): void {
  let original: string;
  {
    using db = new DatabaseSync(pathname);
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)?.sql;
    if (typeof sql !== "string") {
      throw new Error(`Missing fixture FTS table ${table}`);
    }
    original = sql;
    db.exec(`CREATE VIRTUAL TABLE temp.token_probe USING fts5(text);
      INSERT INTO token_probe VALUES ('ab'||char(65534)||'cd');
      CREATE VIRTUAL TABLE temp.token_vocab USING fts5vocab(token_probe, 'row');`);
    const option =
      db.prepare("SELECT count(*) AS n FROM token_vocab").get()?.n === 1
        ? "separators"
        : "tokenchars";
    const changed = sql
      .replace(/,\s*tokenize\s*=\s*'[^']*'/u, "")
      .replace(/\)\s*$/u, `, tokenize = 'unicode61 ${option} ''\ufffe''')`);
    db.enableDefensive?.(false);
    db.exec("PRAGMA writable_schema=ON");
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE name=?").run(changed, table);
  }
  {
    using db = new DatabaseSync(pathname);
    const identifier = quoteSqliteIdentifier(table);
    db.exec(`INSERT INTO ${identifier}(${identifier}) VALUES('rebuild')`);
    db.enableDefensive?.(false);
    db.exec("PRAGMA writable_schema=ON");
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE name=?").run(original, table);
  }
}

/** Change only a fixture index leaf's key bytes, leaving its table and schema intact. */
export function corruptSqliteIndexKey(
  pathname: string,
  indexName: string,
  original: string,
  replacement: string,
): void {
  const database = new DatabaseSync(pathname);
  let pageSize: number;
  let rootPage: number;
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
    rootPage = Number(
      database.prepare("SELECT rootpage FROM sqlite_schema WHERE name = ?").get(indexName)
        ?.rootpage,
    );
  } finally {
    database.close();
  }
  const bytes = fs.readFileSync(pathname);
  const page = bytes.subarray((rootPage - 1) * pageSize, rootPage * pageSize);
  const source = Buffer.from(original);
  const target = Buffer.from(replacement);
  const offset = page.indexOf(source);
  if (source.length !== target.length || offset < 0 || page.includes(source, offset + 1)) {
    throw new Error("Fixture requires one unique, equal-length index key replacement");
  }
  target.copy(page, offset);
  fs.writeFileSync(pathname, bytes);
}
