import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as bundledDir from "../../plugins/bundled-dir.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { logbookPortProvider } from "./logbook-port.js";
import { portBackupFixture } from "./port-backup.test-support.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { requireDatabasePortProvider, sqliteDatabasePortProvider } from "./port-provider.js";
import { teamReportsPortProvider } from "./team-reports-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const allocations = {
  "batches.id": { value: "70", called: true },
  "frames.id": { value: "110", called: true },
  "observations.id": { value: "130", called: true },
  "cards.id": { value: "170", called: true },
};

function rows(file: string, descriptor: PortDescriptor) {
  using db = openNodeSqliteDatabase(file, { readOnly: true, readBigInts: true });
  return descriptor.tables.map((table) => [
    table.name,
    db.prepare(`SELECT * FROM "${table.name}" ORDER BY "${table.pk[0]}"`).all(),
  ]);
}

const hash = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

function portSuite(name: string, run: (client: Client) => () => Promise<void> | undefined) {
  describe.skipIf(!connection)(name, () => {
    const client = new Client({ connectionString: connection });
    beforeAll(() => client.connect());
    const cleanup = run(client);
    afterAll(async () => {
      try {
        await cleanup();
      } finally {
        await client.end();
      }
    });
  });
}

portSuite("Logbook PostgreSQL port and exact backup", (client) => {
  let descriptor: PortDescriptor;
  let directory: string;
  let sourcePath: string;
  let framePath: string;
  let fixture: ReturnType<typeof portBackupFixture>;

  beforeAll(async () => {
    directory = tempDirs.make("logbook-port-");
    sourcePath = path.join(directory, "logbook", "logbook.sqlite");
    framePath = path.join(directory, "logbook", "frames", "2026-07-03", "11.jpg");
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, Buffer.from([0, 255, 128, 1]));
    descriptor = await logbookPortProvider.loadDescriptor();
    fixture = portBackupFixture(client, directory, descriptor);
    using db = openNodeSqliteDatabase(sourcePath);
    db.exec(descriptor.sqlite);
    db.exec(`PRAGMA user_version = 1;
      INSERT INTO batches (id, day, start_ms, end_ms, created_ms, updated_ms) VALUES
        (7, '2026-07-03', 1, 2, 1, 2), (70, '2026-07-03', 1, 2, 1, 2);
      INSERT INTO frames (id, captured_at_ms, day, path, content_hash, batch_id) VALUES
        (11, 1, '2026-07-03', 'placeholder', 'retained', 7),
        (110, 1, '2026-07-03', 'removed', 'removed', 70);
      INSERT INTO observations (id, batch_id, day, start_ms, end_ms, text) VALUES
        (13, 7, '2026-07-03', 1, 2, 'Retained observation'),
        (130, 70, '2026-07-03', 1, 2, 'Removed observation');
      INSERT INTO cards (id, day, start_ms, end_ms, title, summary, keyframe_id, updated_ms) VALUES
        (17, '2026-07-03', 1, 2, 'Retained card', 'Summary', 11, 2),
        (170, '2026-07-03', 1, 2, 'Removed card', 'Summary', 110, 2);
      INSERT INTO standups VALUES ('2026-07-03', 'Retained standup', 2);
      DELETE FROM cards WHERE id = 170;
      DELETE FROM observations WHERE id = 130;
      DELETE FROM frames WHERE id = 110;
      DELETE FROM batches WHERE id = 70;`);
    db.prepare("UPDATE frames SET path = ? WHERE id = 11").run(framePath);
    expect(sqliteDatabasePortProvider(db)).toBe(logbookPortProvider);
    expect(descriptor.inspectSqliteSource?.(db)).toEqual({
      version: 1,
      migrationRequired: false,
      pendingColumns: {},
    });
  });

  it("retains all allocation high-water marks, rows, and file references through port and backup", async () => {
    const snapshot = rows(sourcePath, descriptor);
    const sourceHash = await hash(sourcePath);
    const frameBytes = await fs.readFile(framePath);
    const { file, storeId, query } = fixture;
    const forward = await fixture.forward(sourcePath);
    expect(forward.allocations).toEqual(allocations);
    const reversePath = file("reversed.sqlite");
    {
      using reverse = openNodeSqliteDatabase(reversePath, { readBigInts: true });
      expect(await fixture.reverse(reverse)).toEqual(forward);
      expect(reverse.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all()).toEqual([
        { name: "batches", seq: 70n },
        { name: "cards", seq: 170n },
        { name: "frames", seq: 110n },
        { name: "observations", seq: 130n },
      ]);
    }
    expect(rows(reversePath, descriptor)).toEqual(snapshot);
    const manifest = await fixture.export(sourcePath);
    expect(manifest.source).toMatchObject({ owner: "logbook", schemaVersion: 1, storeId });
    expect(manifest.verification).toEqual(forward);
    expect(rows(file("backup/database.sqlite"), descriptor)).toEqual(snapshot);
    const anchorPath = file("restored-anchor.sqlite");
    const restored = await fixture.restore(manifest, anchorPath);
    const { tables, allocations: restoredAllocations } = await fixture.inspect(
      restored.namespace,
      true,
    );
    expect({ tables, allocations: restoredAllocations }).toEqual(forward);
    using anchor = openNodeSqliteDatabase(anchorPath);
    expect(anchor.prepare("SELECT * FROM openclaw_engine_anchor").get()).toEqual({
      engine: "postgres",
      store_id: storeId,
      schema: restored.namespace,
    });
    expect(await query(`SELECT path FROM "${restored.namespace}".frames`)).toEqual([
      { path: framePath },
    ]);
    expect(await fs.readFile(framePath)).toEqual(frameBytes);
    expect(await hash(sourcePath)).toBe(sourceHash);
    // A deleted maximum remains allocated on both engines after the complete round trip.
    await client.query(`SET search_path = "${restored.namespace}"`);
    for (const [sql, id] of [
      [
        "INSERT INTO batches (day, start_ms, end_ms, created_ms, updated_ms) VALUES ('2026-07-03', 1, 2, 1, 2) RETURNING id",
        "71",
      ],
      [
        "INSERT INTO frames (captured_at_ms, day, path, content_hash) VALUES (1, '2026-07-03', 'next', 'next') RETURNING id",
        "111",
      ],
      [
        "INSERT INTO observations (batch_id, day, start_ms, end_ms, text) VALUES (7, '2026-07-03', 1, 2, 'Next') RETURNING id",
        "131",
      ],
      [
        "INSERT INTO cards (day, start_ms, end_ms, title, summary, updated_ms) VALUES ('2026-07-03', 1, 2, 'Next', 'Next', 2) RETURNING id",
        "171",
      ],
    ] as const) {
      expect(await query(sql)).toEqual([{ id }]);
    }
  });

  it("registers the database for porting and frame artifacts for backup", () => {
    const config = { plugins: { entries: { logbook: { enabled: true } } } };
    const plugins = resolvePluginMetadataSnapshot({
      config,
      stateDir: directory,
      pluginIds: ["logbook"],
    });
    expect(plugins.plugins.find((plugin) => plugin.id === "logbook")?.backupResources).toEqual([
      { disposition: "include", scope: "state", relativePath: "logbook/frames" },
      { disposition: "include", scope: "state", relativePath: "logbook/logbook.sqlite" },
    ]);
    expect(
      logbookPortProvider.resolveRoots({
        config,
        stateDir: directory,
        env: process.env,
        plugins,
      }),
    ).toEqual([sourcePath]);
  });
  return () => fixture?.cleanup();
});

portSuite("Team Reports database port and backup", (client) => {
  let fixture: ReturnType<typeof portBackupFixture>;
  let directory: string;
  beforeAll(async () => {
    directory = tempDirs.make("team-reports-port-");
  });

  it("round-trips every canonical table and restores an exact PostgreSQL backup", async () => {
    const manifestMetadata = JSON.parse(
      await fs.readFile(
        new URL("../../../extensions/team-reports/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    expect(manifestMetadata.backupResources).toContainEqual({
      disposition: "include",
      scope: "state",
      relativePath: "plugins/team-reports/team-reports.sqlite",
    });
    expect(requireDatabasePortProvider("team-reports")).toBe(teamReportsPortProvider);
    const descriptor = await teamReportsPortProvider.loadDescriptor();
    expect(teamReportsPortProvider.minimumPostgresVersion).toBe(descriptor.minimumPostgresVersion);
    fixture = portBackupFixture(client, directory, descriptor);
    const { file, inspect } = fixture;
    const sourcePath = file("source.sqlite");
    {
      using source = openNodeSqliteDatabase(sourcePath);
      source.exec(descriptor.sqlite);
      expect(sqliteDatabasePortProvider(source)).toBe(teamReportsPortProvider);
      source.exec(`
        INSERT INTO team_reports_schema_migrations VALUES ('schema-1', 1787184000000);
        INSERT INTO team_reports_periods VALUES (
          'day', '2026-08-20', 1787184000000, 1787270400000, 'closed', 1787270400000,
          '{"activeMembers":1,"memberCount":2,"totals":{"github":{"total":41}}}', NULL, '# Café 🦞');
        INSERT INTO team_reports_person_days VALUES ('2026-08-20', 'alice', 41, 11, 7, 5, 2, 3, 4, 6, 8, 13);
        INSERT INTO team_reports_runs VALUES (
          'run', 'manual', 1787184000000, NULL, 'running', '[{"period":"day","key":"2026-08-20"}]', NULL, NULL);
      `);
    }
    const staged = await fixture.forward(sourcePath);
    expect(
      Object.fromEntries(Object.entries(staged.tables).map(([name, fact]) => [name, fact.rows])),
    ).toEqual({
      team_reports_periods: 1,
      team_reports_person_days: 1,
      team_reports_runs: 1,
      team_reports_schema_migrations: 1,
    });
    expect(await inspect()).toMatchObject(staged);
    {
      using destination = openNodeSqliteDatabase(file("roundtrip.sqlite"));
      expect(await fixture.reverse(destination)).toEqual(staged);
      expect(
        destination.prepare("SELECT markdown, summary_json FROM team_reports_periods").get(),
      ).toMatchObject({
        markdown: "# Café 🦞",
        summary_json: null,
      });
    }
    const manifest = await fixture.export(file("backup/anchor.sqlite"));
    expect(manifest.source.owner).toBe("team-reports");
    expect(manifest.verification).toEqual(staged);
    const restored = await fixture.restore(manifest, file("restored.sqlite"));
    expect(await inspect(restored.namespace)).toMatchObject(staged);
  });
  it("loads the selected installed plugin when the bundled artifact is absent", async () => {
    const rootDir = fileURLToPath(new URL("../../../extensions/team-reports", import.meta.url));
    const absentBundled = path.join(directory, "empty-bundled");
    await fs.mkdir(absentBundled);
    const bundled = vi.spyOn(bundledDir, "resolveBundledPluginsDir").mockReturnValue(absentBundled);
    try {
      const descriptor = await teamReportsPortProvider.loadDescriptor({
        id: "team-reports",
        rootDir,
        source: path.join(rootDir, "index.ts"),
        origin: "global",
      });
      if (!descriptor.admit || !descriptor.inspectSqliteSource) {
        throw new Error("Team Reports must expose owner admission and inspection");
      }
      const sqlitePath = path.join(directory, "installed.sqlite");
      await descriptor.admit(sqlitePath);
      using database = openNodeSqliteDatabase(sqlitePath);
      expect(descriptor.inspectSqliteSource(database)).toEqual({
        version: 1,
        migrationRequired: false,
        pendingColumns: {},
      });
    } finally {
      bundled.mockRestore();
    }
  });
  return () => fixture?.cleanup();
});
