import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { needsSchemaDowngrade } from "../../scripts/e2e/lib/upgrade-survivor/schema-downgrade-source.mjs";
import {
  inspectFixtureStores,
  readSqliteStoreFacts,
  restoreRaisedFloorStores,
  snapshotFixtureStores,
} from "../../scripts/e2e/lib/upgrade-survivor/schema-store-facts.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function createStore(
  filename: string,
  role: "global" | "agent",
  version: number,
  floor?: number | null,
  content?: number,
) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      `PRAGMA user_version=${version}; CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT${role === "agent" && floor !== undefined ? ", min_reader INTEGER" : ""});`,
    );
    db.prepare(
      `INSERT INTO schema_meta VALUES ('primary', ?, ?, NULL${role === "agent" && floor !== undefined ? ", ?" : ""})`,
    ).run(...(role === "agent" && floor !== undefined ? [role, version, floor] : [role, version]));
    if (role === "global") {
      db.exec(
        `CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT${floor !== undefined ? ", min_reader INTEGER" : ""});`,
      );
      if (content !== undefined || floor !== undefined)
        db.prepare(
          `INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', ?${floor !== undefined ? ", ?" : ""})`,
        ).run(...(floor !== undefined ? [String(content ?? version), floor] : [String(content)]));
    }
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved');");
  } finally {
    db.close();
  }
}

describe("downgrade store custody", () => {
  it("reads legacy deferred content and nullable reader floors without inventing declarations", () => {
    const root = tempDirs.make("schema-store-facts-");
    const shared = join(root, "shared.sqlite");
    const agent = join(root, "agent.sqlite");
    createStore(shared, "global", 40, undefined, 41);
    createStore(agent, "agent", 42, null);
    expect(readSqliteStoreFacts(shared)).toMatchObject({
      role: "shared",
      version: 41,
      headerVersion: 40,
      minReader: 41,
      hasMinReader: false,
    });
    expect(readSqliteStoreFacts(agent)).toMatchObject({
      role: "agent",
      version: 42,
      minReader: 42,
      hasMinReader: false,
    });
  });

  it("projects a mixed rollback by restoring raised stores and retaining compatible bytes", () => {
    const root = tempDirs.make("schema-store-projection-");
    const state = join(root, "state");
    const shared = join(state, "state", "openclaw.sqlite");
    const agent = join(state, "agents", "ops", "agent", "openclaw-agent.sqlite");
    createStore(shared, "global", 42, null);
    createStore(agent, "agent", 42, 42);
    // A snapshot with a live-store basename is not another owner.
    createStore(join(state, "snapshots", "old", "openclaw.sqlite"), "global", 1);
    const baseline = join(root, "preimages");
    const before = snapshotFixtureStores(state, baseline);
    expect(before).toHaveLength(2);
    for (const [file, compatible] of [
      [shared, false],
      [agent, true],
    ] as const) {
      const db = new DatabaseSync(file);
      db.exec("PRAGMA user_version=43; UPDATE schema_meta SET schema_version=43;");
      if (!compatible) db.exec("UPDATE config_machine_state SET value_json='43', min_reader=NULL;");
      db.exec("INSERT INTO sentinel VALUES ('candidate');");
      db.close();
    }
    const after = inspectFixtureStores(state, join(root, "inspection"));
    const kept = readFileSync(agent);
    const projection = restoreRaisedFloorStores(state, baseline, before, after);
    expect(projection.restored).toEqual([join("state", "openclaw.sqlite")]);
    expect(projection.preserved).toEqual([join("agents", "ops", "agent", "openclaw-agent.sqlite")]);
    expect(readSqliteStoreFacts(shared)).toMatchObject({ version: 42, minReader: 42 });
    expect(readSqliteStoreFacts(agent)).toMatchObject({ version: 43, minReader: 42 });
    expect(readFileSync(agent)).toEqual(kept);
  });

  it("rejects invalid floor metadata and an unraised store changed after observation", () => {
    const root = tempDirs.make("schema-store-invalid-");
    const state = join(root, "state");
    const file = join(state, "state", "openclaw.sqlite");
    createStore(file, "global", 42, 43);
    expect(() => readSqliteStoreFacts(file)).toThrow("Invalid min_reader");
    const db = new DatabaseSync(file);
    db.exec("UPDATE config_machine_state SET min_reader=42;");
    db.close();
    const baseline = join(root, "baseline");
    const before = snapshotFixtureStores(state, baseline);
    const after = inspectFixtureStores(state, join(root, "after"));
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("changed")]));
    expect(() => restoreRaisedFloorStores(state, baseline, before, after)).toThrow(
      "Unraised store changed",
    );
  });
});

describe("downgrade diff selection", () => {
  const manifest = { openclaw: { schemaVersions: { state: 41, agent: 42 } } };
  it("selects a schema version or production migration, not test or unrelated state work", () => {
    expect(
      needsSchemaDowngrade(
        manifest,
        { openclaw: { schemaVersions: { state: 42, agent: 42 } } },
        [],
      ),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, ["src/state/openclaw-agent-db-schema.ts"]),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, ["src/state/openclaw-state-db-layout-migration.ts"]),
    ).toBe(true);
    expect(
      needsSchemaDowngrade(manifest, manifest, [
        "src/state/openclaw-state-db-layout-migration.test.ts",
        "src/state/agent-deletion.ts",
        "package.json",
      ]),
    ).toBe(false);
  });
});
