import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as bundledDir from "../../plugins/bundled-dir.js";
import {
  exportPostgresBackup,
  restorePostgresBackup,
} from "../../snapshot/database-backup-core.worker.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitDatabasePortDescriptor } from "./port-descriptor.js";
import { requireDatabasePortProvider, sqliteDatabasePortProvider } from "./port-provider.js";
import { inspectDatabasePort, materializeDatabasePort } from "./port.worker.js";
import { teamReportsPortProvider } from "./team-reports-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("Team Reports database port and backup", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  let directory: string;
  beforeAll(async () => {
    directory = tempDirs.make("team-reports-port-");
    await client.connect();
  });
  afterAll(async () => {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await client.end();
  });

  it("round-trips every canonical table and restores an exact PostgreSQL backup", async () => {
    const manifestMetadata = JSON.parse(
      fs.readFileSync(
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
    const sourcePath = path.join(directory, "source.sqlite");
    const destinationPath = path.join(directory, "roundtrip.sqlite");
    const namespace = `team_reports_port_${randomUUID().replaceAll("-", "")}`;
    namespaces.add(namespace);
    const storeId = randomUUID();
    const common = { descriptor, storeId, assertCurrent() {} };
    const postgres = { engine: "postgres" as const, db: client, namespace };
    const inspect = (ns: string) =>
      inspectDatabasePort({ ...postgres, namespace: ns }, descriptor, storeId);
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
    const staged = await (async () => {
      using source = openNodeSqliteDatabase(sourcePath, { readOnly: true, readBigInts: true });
      return await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: postgres,
        ...common,
      });
    })();
    expect(
      Object.fromEntries(Object.entries(staged.tables).map(([name, fact]) => [name, fact.rows])),
    ).toEqual({
      team_reports_periods: 1,
      team_reports_person_days: 1,
      team_reports_runs: 1,
      team_reports_schema_migrations: 1,
    });
    expect(await inspect(namespace)).toMatchObject(staged);
    {
      using destination = openNodeSqliteDatabase(destinationPath);
      expect(
        await materializeDatabasePort({
          source: postgres,
          destination: { engine: "sqlite", db: destination },
          ...common,
        }),
      ).toEqual(staged);
      expect(
        destination.prepare("SELECT markdown, summary_json FROM team_reports_periods").get(),
      ).toMatchObject({
        markdown: "# Café 🦞",
        summary_json: null,
      });
    }
    const backupDirectory = path.join(directory, "backup");
    fs.mkdirSync(backupDirectory);
    const anchorPath = path.join(backupDirectory, "anchor.sqlite");
    {
      using anchor = openNodeSqliteDatabase(anchorPath);
      anchor.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      anchor
        .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
        .run(storeId, namespace);
    }
    const anchor = { engine: "postgres" as const, storeId, namespace };
    const backup = { client, directory: backupDirectory, profile: "exact" as const, ...common };
    const manifest = await exportPostgresBackup({
      ...backup,
      descriptor: await admitDatabasePortDescriptor(postgres, descriptor),
      anchor,
      sourcePath: anchorPath,
    });
    expect(manifest.source.owner).toBe("team-reports");
    expect(manifest.verification).toEqual(staged);
    const restored = await restorePostgresBackup({
      ...backup,
      manifest,
      anchorPath: path.join(directory, "restored.sqlite"),
    });
    namespaces.add(restored.namespace);
    expect(await inspect(restored.namespace)).toMatchObject(staged);
  });
  it("loads the selected installed plugin when the bundled artifact is absent", async () => {
    const rootDir = fileURLToPath(new URL("../../../extensions/team-reports", import.meta.url));
    const absentBundled = path.join(directory, "empty-bundled");
    fs.mkdirSync(absentBundled);
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
});
