import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { captureUpdateRecoveryBaseline } from "../infra/update-recovery-baseline-capture.js";
import { resolveCapturedRegistryPath } from "../infra/update-recovery-path.js";
import * as pluginResources from "../plugins/doctor-contract-registry.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import * as agentRegistry from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "../state/openclaw-migration-witness.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { parseUpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { inspectDoctorMigrationPreservation } from "./doctor-migration-preservation.js";

afterEach(() => vi.restoreAllMocks());

it("rejects registry traversal through directories absent from the sealed inventory", () => {
  const root = path.resolve("/capture");
  const directory = path.join(root, "recorded");
  const locator = `${directory}${path.sep}..${path.sep}agent.sqlite`;
  for (const traversal of [
    locator,
    `${root}${path.sep}agent.sqlite${path.sep}.`,
    `${root}${path.sep}agent.sqlite${path.sep}`,
  ]) {
    expect(() => resolveCapturedRegistryPath(traversal, new Map(), new Set([root]))).toThrow(
      /requires a recorded directory/,
    );
  }
  for (const equivalent of [
    `${root}${path.sep}.${path.sep}agent.sqlite`,
    `${root}${path.sep}custom${path.sep}${path.sep}agent.sqlite`,
  ]) {
    expect(resolveCapturedRegistryPath(equivalent, new Map(), new Set())).toBe(
      path.normalize(equivalent),
    );
  }
  expect(resolveCapturedRegistryPath(locator, new Map(), new Set([root, directory]))).toBe(
    path.join(root, "agent.sqlite"),
  );
});

it("preserves plugin rowids, views, and triggers as well as declared values", () => {
  using database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA user_version = -1;
    CREATE TABLE payload(value TEXT CHECK(length(value) > 0));
    INSERT INTO payload(rowid, value) VALUES (7, 'retained');
    CREATE VIEW payload_view AS SELECT rowid, value FROM payload;
    CREATE TRIGGER payload_guard BEFORE DELETE ON payload
      BEGIN SELECT RAISE(ABORT, 'protected'); END;
    CREATE TABLE "plugin.events" ("payload.id" TEXT PRIMARY KEY, "event.bytes" BLOB) WITHOUT ROWID;
    INSERT INTO "plugin.events" VALUES ('retained-id', x'00ff2a');
    CREATE TABLE "" ("" TEXT);
    INSERT INTO "" VALUES ('empty identifiers');
  `);
  const original = captureOpenClawMigrationWitness(database);
  for (const mutation of [
    "UPDATE payload SET rowid = 8",
    "DROP VIEW payload_view",
    "DROP TRIGGER payload_guard",
    "PRAGMA application_id = 42",
    "PRAGMA user_version = -2",
  ]) {
    database.exec("SAVEPOINT changed_plugin");
    database.exec(mutation);
    expect(() =>
      assertOpenClawMigrationWitnessPreserved(original, captureOpenClawMigrationWitness(database)),
    ).toThrow(/changed or lost|owner or version transition/);
    database.exec("ROLLBACK TO changed_plugin; RELEASE changed_plugin");
  }
  expect(
    assertOpenClawMigrationWitnessPreserved(original, captureOpenClawMigrationWitness(database)),
  ).toEqual({ warnings: [] });
});

it("binds semantic preservation to original backups across a partial migration and retry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const external = state.path("external.sqlite");
    const externalAlias = state.path("external-alias.sqlite");
    const plugin = state.path("plugin.sqlite");
    const pluginDirectory = state.path("plugin-data");
    await fs.mkdir(pluginDirectory);
    const asset = path.join(pluginDirectory, "original.bin");
    const missing = state.path("preexisting-missing.bin");
    await fs.writeFile(asset, Buffer.from([0, 255, 42]));
    using externalDatabase = new DatabaseSync(external);
    externalDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    externalDatabase.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
    externalDatabase.exec(`PRAGMA user_version = 24;
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', 24, 'external', 1, 1);
        INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('agent:external:main', 'sentinel', '{"sessionId":"sentinel","updatedAt":1,"delivery":{"kind":"none"}}', 1);
        INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('sentinel', 'agent:external:main', 1, 1);
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('sentinel', 1, '{"id":"external-original-history"}', 1);
        UPDATE session_nodes SET entry_valid = 1`);
    expect((await fs.readFile(external)).includes(Buffer.from("external-original-history"))).toBe(
      false,
    );
    await fs.chmod(external, 0o600);
    await fs.symlink(path.basename(external), externalAlias);
    {
      using db = new DatabaseSync(plugin);
      db.exec(
        "CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB); INSERT INTO payload VALUES (1, x'00ff2a'); CREATE TABLE indexed(value TEXT); INSERT INTO indexed VALUES ('index-original'); CREATE INDEX payload_lookup ON indexed(value)",
      );
    }
    const shared = openOpenClawStateDatabase();
    shared.db
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 24, 1)",
      )
      .run("external", externalAlias);
    shared.db
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 24, 1)",
      )
      .run("external", external);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    vi.spyOn(pluginResources, "preparePluginDoctorMigrationBackupResources").mockImplementation(
      async () => ({
        resources: [
          { path: plugin, kind: "sqlite" },
          { path: pluginDirectory, kind: "directory" },
          { path: missing, kind: "file" },
        ],
        deferredPluginIds: new Set(),
        notices: [],
        assertCurrent() {},
      }),
    );
    const maintenance = await beginDoctorMaintenance({
      root: process.cwd(),
      options: { repair: true, nonInteractive: true },
      runtime: {
        log() {},
        error() {},
        exit() {
          throw new Error("Unexpected Doctor exit");
        },
      },
    });
    expect(maintenance).toBeDefined();
    try {
      await maintenance!.run(async () => {
        const scope = getOpenClawDatabaseMaintenanceScope()!;
        const capture = (runId: string) =>
          captureUpdateRecoveryBaseline({
            runId,
            installRoot: process.cwd(),
            env: state.env,
            drivers: [],
            assertCurrent: scope.assertAdmission,
            acquisition: { mode: "maintenance-owner" },
          });
        await backupDoctorMigrationDatabases({
          env: state.env,
          pendingDatabasePaths: [external],
          databasePaths: [external],
        });
        const backupPaths = (await fs.readdir(path.dirname(external))).filter(
          (name) =>
            name.startsWith("external.sqlite.pre-startup-migration-") && name.endsWith(".bak"),
        );
        expect(backupPaths).toHaveLength(1);
        const backupPath = path.join(path.dirname(external), backupPaths[0]!);
        const backupBytes = await fs.readFile(backupPath);
        const original = (await capture("witness-original")).ref;
        const originalBytes = await fs.readFile(original.manifestPath);
        const migrate = () =>
          migrateLegacyMediaPersistence({
            env: state.env,
            configuredAgentDatabaseTargets: [{ agentId: "external", path: externalAlias }],
          });
        const registration = vi
          .spyOn(agentRegistry, "registerOpenClawAgentDatabase")
          .mockImplementationOnce(() => {
            throw new Error("fixture registration interrupted");
          });
        const partialResult = await migrate();
        registration.mockRestore();
        expect(partialResult.warnings.join("\n")).toContain("fixture registration interrupted");
        expect(externalDatabase.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        const registryVersions = () =>
          openOpenClawStateDatabase()
            .db.prepare(
              "SELECT schema_version FROM agent_databases WHERE agent_id = 'external' ORDER BY schema_version",
            )
            .all()
            .map((row) => row.schema_version);
        expect(registryVersions()).toEqual([24, 24]);
        const partial = (await capture("witness-partial")).ref;
        expect(
          (await inspectDoctorMigrationPreservation({ original: partial, candidate: partial }))
            .status,
        ).toBe("preserved-with-warnings");
        await expect(
          inspectDoctorMigrationPreservation({ original, candidate: partial }),
        ).rejects.toThrow(/Registry schema version/);
        await backupDoctorMigrationDatabases({
          env: state.env,
          pendingDatabasePaths: [external],
          databasePaths: [external],
        });
        const retry = await migrate();
        expect(retry.warnings).toEqual([]);
        expect(externalDatabase.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(registryVersions()).toEqual([24, OPENCLAW_AGENT_SCHEMA_VERSION]);
        expect(await fs.readFile(backupPath)).toEqual(backupBytes);
        expect(await fs.readFile(original.manifestPath)).toEqual(originalBytes);
        const candidate = (await capture("witness-migrated")).ref;
        const result = await inspectDoctorMigrationPreservation({ original, candidate });
        expect(
          (await inspectDoctorMigrationPreservation({ original: partial, candidate })).status,
        ).toBe("preserved-with-warnings");
        expect(result).toMatchObject({
          status: "preserved-with-warnings",
          activationAuthorized: false,
        });
        expect(result.databases).toBeGreaterThanOrEqual(3);
        expect(result.warnings).toContain(`Preexisting missing resource: ${missing}`);
        await fs.writeFile(missing, "unclassified new content");
        const filledResource = (await capture("witness-filled-resource")).ref;
        await expect(
          inspectDoctorMigrationPreservation({ original, candidate: filledResource }),
        ).rejects.toThrow(/previously missing resource/);
        await fs.unlink(missing);
        const addedFile = path.join(pluginDirectory, "new-policy.txt");
        await fs.writeFile(addedFile, "new policy");
        const addedResource = (await capture("witness-added-resource")).ref;
        await expect(
          inspectDoctorMigrationPreservation({ original, candidate: addedResource }),
        ).rejects.toThrow(/added an unclassified resource/);
        await fs.unlink(addedFile);
        await fs.chmod(plugin, 0o600);
        const changedMode = (await capture("witness-changed-mode")).ref;
        await expect(
          inspectDoctorMigrationPreservation({ original, candidate: changedMode }),
        ).rejects.toThrow(/file kind or mode/);
        await fs.chmod(plugin, 0o644);
        await expect(
          inspectDoctorMigrationPreservation({
            original: { ...original, manifestSha256: candidate.manifestSha256 },
            candidate,
          }),
        ).rejects.toThrow(/manifest changed/);
        // Loss in a newly sealed candidate must still fail against the first originals.
        {
          using db = new DatabaseSync(plugin);
          db.exec("DELETE FROM payload");
        }
        const lost = (await capture("witness-lost-plugin")).ref;
        await expect(
          inspectDoctorMigrationPreservation({ original, candidate: lost }),
        ).rejects.toThrow(/changed or lost/);
        const candidateManifest = parseUpdateRecoveryBackupManifest(
          await fs.readFile(candidate.manifestPath, "utf8"),
        );
        const indexedPayload = candidateManifest.entries.find(
          (entry) => entry.sourcePath === plugin,
        );
        if (indexedPayload?.kind !== "file") {
          throw new Error("Missing plugin payload");
        }
        const indexedPath = path.join(candidate.directory, indexedPayload.archivePath);
        corruptSqliteIndexKey(indexedPath, "payload_lookup", "index-original", "index-damaged!");
        indexedPayload.sha256 = createHash("sha256")
          .update(await fs.readFile(indexedPath))
          .digest("hex");
        const corruptManifest = JSON.stringify(candidateManifest);
        await fs.writeFile(candidate.manifestPath, corruptManifest);
        await expect(
          inspectDoctorMigrationPreservation({
            original,
            candidate: {
              ...candidate,
              manifestSha256: createHash("sha256").update(corruptManifest).digest("hex"),
            },
          }),
        ).rejects.toThrow(/integrity_check/);
        // An unreadable or substituted original payload cannot become a fresh baseline.
        const manifest = parseUpdateRecoveryBackupManifest(originalBytes.toString("utf8"));
        const payload = manifest.entries.find((entry) => entry.sourcePath === external);
        expect(payload?.kind).toBe("file");
        if (payload?.kind !== "file") {
          throw new Error("Missing external payload");
        }
        await fs.writeFile(path.join(original.directory, payload.archivePath), "corrupt");
        await expect(inspectDoctorMigrationPreservation({ original, candidate })).rejects.toThrow(
          /payload does not match/,
        );
        expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(
          original.manifestSha256,
        );
      });
    } finally {
      await maintenance?.release();
    }
  });
});
