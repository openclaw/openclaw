// Stand-in for a successor's boot migration under exclusive shared-state custody.
import { DatabaseSync } from "node:sqlite";

const [live] = process.argv.slice(2);
if (!live) {
  throw new Error("Expected the live shared state database path");
}
const db = new DatabaseSync(live);
try {
  db.exec(`
    PRAGMA locking_mode=EXCLUSIVE;
    BEGIN EXCLUSIVE;
    CREATE INDEX successor_boot_update_phase ON update_runs(phase);
    COMMIT;
  `);
} finally {
  db.close();
}
