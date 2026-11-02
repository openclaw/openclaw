import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { corruptSqliteIndexKey } from "../infra/sqlite-index-corruption.test-support.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { captureUpdateRecoveryBaseline } from "../infra/update-recovery-baseline-capture.js";
import { resolveCapturedRegistryPath } from "../infra/update-recovery-path.js";
import * as pluginResources from "../plugins/doctor-contract-registry.js";
import {
  MEDIA_ROWS_MIGRATION_META_KEY,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db-contract.js";
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
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

afterEach(() => vi.restoreAllMocks());

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function capturedPayload(
  manifest: ReturnType<typeof parseUpdateRecoveryBackupManifest>,
  source: string,
) {
  const payload = manifest.entries.find((entry) => entry.sourcePath === source);
  expect(payload?.kind).toBe("file");
  if (payload?.kind !== "file") {
    throw new Error(`Missing payload: ${source}`);
  }
  return payload;
}

it("rejects registry traversal through directories absent from the sealed inventory", () => {
  const root = path.resolve("/capture");
  const directory = path.join(root, "recorded");
  const locator = `${directory}${path.sep}..${path.sep}agent.sqlite`;
  const resolve = (value: string, directories: string[] = []) =>
    resolveCapturedRegistryPath(value, new Map(), new Set(directories));
  for (const traversal of [
    locator,
    `${root}${path.sep}agent.sqlite${path.sep}.`,
    `${root}${path.sep}agent.sqlite${path.sep}`,
  ]) {
    expect(() => resolve(traversal, [root])).toThrow(/requires a recorded directory/);
  }
  for (const equivalent of [
    `${root}${path.sep}.${path.sep}agent.sqlite`,
    `${root}${path.sep}custom${path.sep}${path.sep}agent.sqlite`,
  ]) {
    expect(resolve(equivalent)).toBe(path.normalize(equivalent));
  }
  expect(resolve(locator, [root, directory])).toBe(path.join(root, "agent.sqlite"));
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
  const check = () =>
    assertOpenClawMigrationWitnessPreserved(original, captureOpenClawMigrationWitness(database));
  for (const mutation of [
    "UPDATE payload SET rowid = 8",
    "DROP VIEW payload_view",
    "DROP TRIGGER payload_guard",
    "PRAGMA application_id = 42",
    "PRAGMA user_version = -2",
  ]) {
    database.exec(`SAVEPOINT changed_plugin; ${mutation}`);
    expect(check).toThrow(/changed or lost|owner or version transition/);
    database.exec("ROLLBACK TO changed_plugin; RELEASE changed_plugin");
  }
  expect(check()).toEqual({ warnings: [] });
});

it("excludes only the agent media repair completion row from retained metadata", () => {
  using database = new DatabaseSync(":memory:");
  database.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
  database.exec(`PRAGMA user_version = 24;
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', 24, 'main', 1, 1)`);
  const owner = { role: "agent", agentId: "main" } as const;
  const original = captureOpenClawMigrationWitness(database, owner);
  const opaqueOriginal = captureOpenClawMigrationWitness(database);
  const check = (before = original, after = captureOpenClawMigrationWitness(database, owner)) =>
    assertOpenClawMigrationWitnessPreserved(before, after);
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES (?, 'agent', 1, 'main', 2, 2)`)
    .run(MEDIA_ROWS_MIGRATION_META_KEY);
  expect(() => check()).not.toThrow();
  expect(() => check(opaqueOriginal, captureOpenClawMigrationWitness(database))).toThrow(
    /retained database content: schema_meta/,
  );
  for (const mutation of [
    "UPDATE schema_meta SET created_at = 3 WHERE meta_key = 'primary'",
    "UPDATE schema_meta SET meta_key = 'unclassified-repair' WHERE schema_version = 1",
  ]) {
    database.exec(`SAVEPOINT changed_metadata; ${mutation}`);
    expect(() => check()).toThrow(/retained database content: schema_meta/);
    database.exec("ROLLBACK TO changed_metadata; RELEASE changed_metadata");
  }
});

it("binds semantic preservation to original backups across a partial migration and retry", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    withDaemonRuntimePinStore(state.env, true, (db) => {
      db.exec(
        "INSERT INTO daemon_runtime_pins VALUES ('daemon-runtime-pin:fixture', 'malformed intent', 1)",
      );
    });
    const external = state.path("external.sqlite");
    const externalAlias = state.path("external-alias.sqlite");
    const plugin = state.path("plugin.sqlite");
    const pluginDirectory = state.path("plugin-data");
    await fs.mkdir(pluginDirectory);
    const missing = state.path("preexisting-missing.bin");
    await fs.writeFile(path.join(pluginDirectory, "original.bin"), Buffer.from([0, 255, 42]));
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
    const register = openOpenClawStateDatabase().db.prepare(
      "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 24, 1)",
    );
    for (const target of [externalAlias, external]) {
      register.run("external", target);
    }
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
      runtime: createThrowingTestRuntime(),
    });
    expect(maintenance).toBeDefined();
    try {
      await maintenance!.run(async () => {
        const scope = getOpenClawDatabaseMaintenanceScope()!;
        const capture = async (runId: string) => {
          // Registry assertions reopen this handle; drain its WAL maintenance before raw capture.
          await closeOpenClawStateDatabaseAsync();
          const captured = await captureUpdateRecoveryBaseline({
            runId,
            installRoot: process.cwd(),
            env: state.env,
            drivers: [],
            assertCurrent: scope.assertAdmission,
            acquisition: { mode: "maintenance-owner" },
          });
          return captured.ref;
        };
        const backup = () =>
          backupDoctorMigrationDatabases({
            env: state.env,
            pendingDatabasePaths: [external],
            databasePaths: [external],
          });
        await backup();
        const backupPaths = (await fs.readdir(path.dirname(external))).filter(
          (name) =>
            name.startsWith("external.sqlite.pre-startup-migration-") && name.endsWith(".bak"),
        );
        expect(backupPaths).toHaveLength(1);
        const backupPath = path.join(path.dirname(external), backupPaths[0]!);
        const backupBytes = await fs.readFile(backupPath);
        const original = await capture("witness-original");
        const inspect = (candidate: typeof original, before = original) =>
          inspectDoctorMigrationPreservation({ original: before, candidate });
        const expectRejectedCapture = async (runId: string, error: RegExp) => {
          await expect(inspect(await capture(runId))).rejects.toThrow(error);
        };
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
        const partial = await capture("witness-partial");
        expect((await inspect(partial, partial)).status).toBe("preserved-with-warnings");
        await expect(inspect(partial)).rejects.toThrow(/Registry schema version/);
        await backup();
        const retry = await migrate();
        expect(retry.warnings).toEqual([]);
        expect(externalDatabase.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(registryVersions()).toEqual([24, OPENCLAW_AGENT_SCHEMA_VERSION]);
        expect(await fs.readFile(backupPath)).toEqual(backupBytes);
        expect(await fs.readFile(original.manifestPath)).toEqual(originalBytes);
        const candidate = await capture("witness-migrated");
        const result = await inspect(candidate);
        expect((await inspect(candidate, partial)).status).toBe("preserved-with-warnings");
        expect(result).toMatchObject({
          status: "preserved-with-warnings",
          activationAuthorized: false,
        });
        expect(result.databases).toBeGreaterThanOrEqual(3);
        expect(result.warnings).toContain(`Preexisting missing resource: ${missing}`);
        withDaemonRuntimePinStore(state.env, true, (db) => {
          db.prepare("UPDATE daemon_runtime_pins SET value_json = ?").run("changed intent");
        });
        await expectRejectedCapture("witness-changed-intent", /retained database content/);
        withDaemonRuntimePinStore(state.env, true, (db) => {
          db.prepare("UPDATE daemon_runtime_pins SET value_json = ?").run("malformed intent");
        });
        await fs.writeFile(missing, "unclassified new content");
        await expectRejectedCapture("witness-filled-resource", /previously missing resource/);
        await fs.unlink(missing);
        const addedFile = path.join(pluginDirectory, "new-policy.txt");
        await fs.writeFile(addedFile, "new policy");
        await expectRejectedCapture("witness-added-resource", /added an unclassified resource/);
        await fs.unlink(addedFile);
        await fs.chmod(plugin, 0o600);
        await expectRejectedCapture("witness-changed-mode", /file kind or mode/);
        await fs.chmod(plugin, 0o644);
        await expect(
          inspect(candidate, { ...original, manifestSha256: candidate.manifestSha256 }),
        ).rejects.toThrow(/manifest changed/);
        // Loss in a newly sealed candidate must still fail against the first originals.
        {
          using db = new DatabaseSync(plugin);
          db.exec("DELETE FROM payload");
        }
        await expectRejectedCapture("witness-lost-plugin", /changed or lost/);
        const candidateManifest = parseUpdateRecoveryBackupManifest(
          await fs.readFile(candidate.manifestPath, "utf8"),
        );
        const indexedPayload = capturedPayload(candidateManifest, plugin);
        const indexedPath = path.join(candidate.directory, indexedPayload.archivePath);
        corruptSqliteIndexKey(indexedPath, "payload_lookup", "index-original", "index-damaged!");
        indexedPayload.sha256 = sha256(await fs.readFile(indexedPath));
        const corruptManifest = JSON.stringify(candidateManifest);
        await fs.writeFile(candidate.manifestPath, corruptManifest);
        await expect(
          inspect({ ...candidate, manifestSha256: sha256(corruptManifest) }),
        ).rejects.toThrow(/integrity_check/);
        // An unreadable or substituted original payload cannot become a fresh baseline.
        const manifest = parseUpdateRecoveryBackupManifest(originalBytes.toString("utf8"));
        const payload = capturedPayload(manifest, external);
        await fs.writeFile(path.join(original.directory, payload.archivePath), "corrupt");
        await expect(inspect(candidate)).rejects.toThrow(/payload does not match/);
        expect(sha256(originalBytes)).toBe(original.manifestSha256);
      });
    } finally {
      await maintenance?.release();
    }
  }));
