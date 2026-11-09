import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getOpenClawStateRuntimeSchema } from "../../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";

const tempDirs = useStateDatabaseTempDirs();

it("worker placement move schema survives a same-version previous reader and candidate reopen", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("placement-move-schema-") } };
  const database = openOpenClawStateDatabase(options);
  const schemaMetadata = (db: typeof database.db) => ({
    version: db.prepare("PRAGMA user_version").get(),
    metadata: db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  });
  const metadataBefore = schemaMetadata(database.db);
  const previousMoveTable = OPENCLAW_STATE_SCHEMA_SQL.match(
    /CREATE TABLE IF NOT EXISTS worker_session_placement_moves \([\s\S]*?\) STRICT;/u,
  )![0].replace(/^\s*(?:target_machine_class|target_os|abandon_source)\s+[^\n]*\n/gmu, "");
  writePlacementEnvironmentFixture(database, {
    environmentId: "environment-source",
    state: "attached",
    ownerEpoch: 7,
    attachedSessionIds: ["session-move"],
  });
  database.db.exec(`
      DROP TABLE worker_session_placement_moves;
      ${previousMoveTable}
      INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, execution_mode, state, environment_id,
        transition_generation, active_owner_epoch, workspace_base_manifest_ref,
        remote_workspace_dir, worker_bundle_hash, created_at_ms, updated_at_ms,
        state_changed_at_ms
      ) VALUES (
        'session-move', 'main', 'agent:main:move', 'worker-turn', 'active',
        'environment-source', 4, 7, 'sha256:base', '/workspace/move',
        '${"a".repeat(64)}', 1000, 1000, 1000
      );
    `);
  const store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
  const readProjection = () => store.readProjection(["session-move"]);
  const beforeMove = await readProjection();
  expect(beforeMove.placements.get("session-move")).toMatchObject({ state: "active" });
  expect(beforeMove.moves.size).toBe(0);
  expect(beforeMove.workspaceResultReconcilingSessionIds.size).toBe(0);
  database.db.exec("DROP TABLE worker_session_placement_moves");
  const withoutMoveTable = await readProjection();
  expect(withoutMoveTable.placements.get("session-move")).toMatchObject({ state: "active" });
  expect(withoutMoveTable.moves.size).toBe(0);
  database.db.exec(previousMoveTable);
  const begun = await store.beginPlacementMove({
    sessionId: "session-move",
    source: { generation: 4, environmentId: "environment-source", ownerEpoch: 7 },
    target: { kind: "profile", profileId: "destination", machineClass: "beast", os: "os-a" },
  });
  expect((await readProjection()).moves.get("session-move")).toEqual(begun.intent);
  expect(database.db.prepare("PRAGMA table_info(worker_session_placement_moves)").all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "target_machine_class" }),
      expect.objectContaining({ name: "target_os", type: "TEXT", notnull: 0, dflt_value: null }),
      expect.objectContaining({ name: "abandon_source", type: "INTEGER", notnull: 0 }),
    ]),
  );
  const databasePath = database.path;
  await closeStateDatabaseForTest();

  const previousReader = new DatabaseSync(databasePath);
  assertSqliteSchemaContains(
    previousReader,
    "previous state schema",
    getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
  );
  expect(
    previousReader
      .prepare("SELECT state, transition_generation FROM worker_session_placements")
      .get(),
  ).toEqual({ state: "draining", transition_generation: 5 });
  previousReader.close();

  const reopened = openOpenClawStateDatabase(options);
  const reopenedStore = createWorkerSessionPlacementStore({ database: reopened });
  expect(await reopenedStore.getPlacementMoveAsync("session-move")).toEqual(begun.intent);
  expect((await reopenedStore.readProjection(["session-move"])).moves.get("session-move")).toEqual(
    begun.intent,
  );
  expect(schemaMetadata(reopened.db)).toEqual(metadataBefore);
});
