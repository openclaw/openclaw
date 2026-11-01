import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { DoctorDatabaseEngineInspectionInput } from "./doctor-database-engine-inspection.types.js";

const fixture = vi.hoisted(() => {
  const handlers: Array<(input: DoctorDatabaseEngineInspectionInput) => Promise<unknown>> = [];
  return { handlers, metadata: vi.fn() };
});
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveWorkerTasks: (handler: (typeof fixture.handlers)[number]) => fixture.handlers.push(handler),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: fixture.metadata,
}));
import "./doctor-database-engine-inspection.worker.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("shares one metadata read image per SQLite engine inspection and refreshes the next", async () => {
  const stateDir = directories.make("doctor-engine-scope-");
  const env = {
    HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const options = { env, path: path.join(stateDir, "state", "openclaw.sqlite") };
  openOpenClawStateDatabase(options);
  closeOpenClawStateDatabaseForTest();
  using writer = openNodeSqliteDatabase(options.path);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('first')",
  );
  const artifacts = () =>
    ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(options.path + suffix));
  const observed: unknown[][] = [];
  const readers: Array<{ isOpen: boolean }> = [];
  let committed = artifacts();
  fixture.metadata.mockImplementation(() => {
    const read = () =>
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        readers.push(db);
        return db.prepare("SELECT value FROM probe").get()?.value;
      }, options);
    const first = read();
    expect(artifacts()).toEqual(committed);
    writer.exec(`UPDATE probe SET value='${first === "first" ? "second" : "third"}'`);
    committed = artifacts();
    observed.push([first, read()]);
    return { plugins: [] };
  });
  const producer = vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync");
  for (const expected of ["first", "second"]) {
    await fixture.handlers[0]!({ config: {}, env, stateDir });
    expect(observed.at(-1)).toEqual([expected, expected]);
    expect(readers.at(-1) === readers.at(-2)).toBe(true);
    expect(readers.every((reader) => !reader.isOpen)).toBe(true);
    expect(artifacts()).toEqual(committed);
  }
  expect(producer.mock.calls.filter(([pathname]) => pathname === options.path)).toHaveLength(2);
});
