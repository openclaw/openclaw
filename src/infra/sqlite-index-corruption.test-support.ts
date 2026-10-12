import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
