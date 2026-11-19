// Stand-in for a successor replacing shared state. The baseline has no boot-upgrade
// tree owner; exercise the same physical replacement as its cache regressions.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [live] = process.argv.slice(2);
if (!live) {
  throw new Error("Expected the live shared state database path");
}
const next = `${live}.successor`;
const source = new DatabaseSync(live, { readOnly: true });
try {
  source.exec(`VACUUM INTO '${next.replaceAll("'", "''")}'`);
} finally {
  source.close();
}
// Preserve the previous generation and its companions together so neither the
// successor nor the assertion reader pairs a database with another file's WAL.
const previous = `${live}.pre-successor`;
fs.renameSync(live, previous);
for (const suffix of ["-wal", "-journal", "-shm", ".seal"]) {
  if (fs.existsSync(`${live}${suffix}`)) {
    fs.renameSync(`${live}${suffix}`, `${previous}${suffix}`);
  }
}
fs.renameSync(next, live);
