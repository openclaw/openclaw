import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RACING_COLUMN = "synthetic_lazy_column";

afterEach(closeState);

function prepare(prefix: string) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make(prefix) } };
  const file = openState(options).path;
  closeState();
  const database = openNodeSqliteDatabase(file);
  // Admission snapshots the schema here; the peer write below lands after that snapshot, which
  // is the same window a second process opens by adding a first-use column while this one runs.
  admitSqliteSchema(database);
  const { DatabaseSync } = requireNodeSqlite();
  const peer = new DatabaseSync(file);
  peer.exec(`ALTER TABLE device_bootstrap_tokens ADD COLUMN ${RACING_COLUMN} TEXT;`);
  return { database, peer };
}

it("treats a column added by another connection as already present", () => {
  const { database, peer } = prepare("state-lazy-column-race-");
  using connection = peer;
  using db = database;

  expect(ensureColumn(db, "device_bootstrap_tokens", `${RACING_COLUMN} TEXT`)).toBe(false);
  const columns = db.prepare("PRAGMA table_info(device_bootstrap_tokens)").all();
  expect(columns.filter((row) => row.name === RACING_COLUMN)).toHaveLength(1);
  connection.exec("SELECT 1");
});

it("still refuses a same-named column with a different shape", () => {
  const { database, peer } = prepare("state-lazy-column-shape-");
  using connection = peer;
  using db = database;

  expect(() => ensureColumn(db, "device_bootstrap_tokens", `${RACING_COLUMN} INTEGER`)).toThrow(
    new RegExp(`duplicate column name: ${RACING_COLUMN}`, "u"),
  );
  connection.exec("SELECT 1");
});

it("refuses a constrained duplicate instead of proving it from the bare type", () => {
  const { database, peer } = prepare("state-lazy-column-constrained-");
  using connection = peer;
  using db = database;
  connection.exec(
    `ALTER TABLE device_bootstrap_tokens ADD COLUMN constrained_column TEXT NOT NULL DEFAULT 'x';`,
  );

  expect(() => ensureColumn(db, "device_bootstrap_tokens", "constrained_column TEXT")).toThrow(
    /duplicate column name: constrained_column/u,
  );
  connection.exec("SELECT 1");
});
