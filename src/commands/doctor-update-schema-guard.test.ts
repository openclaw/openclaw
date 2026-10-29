import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { writeFixtureJsonSync } from "../cli/cli-fixtures.test-support.js";
import { waitForCliSignalExit, waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { resolveStateDir } from "../config/paths.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import * as backupCreate from "../infra/backup-create.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as packageRoot from "../infra/openclaw-root.js";
import { revokeSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import * as integrity from "../infra/sqlite-integrity-worker.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot-source.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "../state/openclaw-agent-schema-v24.test-support.js";
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { backupRestoreCommand } from "./backup-restore.js";
import * as backupVerify from "./backup-verify.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import type { DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import {
  guardUpdateDoctorSchemaUpgrade,
  preflightUpdateDoctorCli,
} from "./doctor-update-schema-guard.js";

beforeEach(() => {
  // Exact 2026.9.2 package caller arguments; plugin deferral does not identify the schema phase.
  for (const [key, value] of Object.entries(
    buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      deferConfiguredPluginInstallRepair: true,
      serviceRepairPolicy: "external",
      compatibilityHostVersion: VERSION,
    }),
  )) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type AgentFixture = Awaited<ReturnType<typeof legacyAgentFixture>>;
function withLegacyAgent(
  postCore: boolean,
  run: (fixture: AgentFixture, state: OpenClawTestState) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) =>
    run(await legacyAgentFixture(postCore), state),
  );
}

function withDatabase<T>(pathname: string, readOnly: boolean, run: (db: DatabaseSync) => T): T {
  using db = new DatabaseSync(pathname, { readOnly });
  return run(db);
}

function captureBytes(files: string[]) {
  const before = files.map((file) => fs.readFileSync(file));
  return () => expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
}

function repairOptions(f: AgentFixture, assertCurrent = () => {}) {
  return { schemas: f.schemas, postCoreSchemaRepair: { runId: f.runId, assertCurrent } };
}

function migrateAgent(pathname: string, env: NodeJS.ProcessEnv) {
  return withAgentDatabaseMaintenanceLease({ env }, (lease) =>
    migrateOpenClawAgentDatabaseForMaintenance({ agentId: "main", pathname }, lease),
  );
}

function replaceAgent(pathname: string) {
  fs.renameSync(pathname, `${pathname}.previous`);
  fs.copyFileSync(`${pathname}.previous`, pathname);
}

function stubRehearsalEnv(stateDir: string) {
  for (const [key, value] of Object.entries(buildUpdateRehearsalPathEnv(stateDir))) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
}

async function legacyAgentFixture(postCore: boolean, version = "2026.9.2") {
  const privateRoot = fs.realpathSync(resolveStateDir());
  const handoff = createManagedHandoffTestBinding(privateRoot);
  installPrivateUpdateHandoffStore(privateRoot);
  vi.stubEnv(
    "NODE_OPTIONS",
    [process.env.NODE_OPTIONS, handoff.nodeOption].filter(Boolean).join(" "),
  );
  handoff.assertPath();
  // The guard's install discovery sees an isolated package, not the test checkout.
  const root = path.join(resolveStateDir(), "npm", "candidate");
  fs.mkdirSync(root, { recursive: true });
  writeFixtureJsonSync(path.join(root, "package.json"), { name: "openclaw", version: VERSION });
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  const agent = openOpenClawAgentDatabase({ agentId: "main" });
  const pathname = agent.path;
  const run = createUpdateRun({
    trigger: "cli",
    before: { version },
    ...(version === VERSION ? { origin: { driver: readUpdateRunDriver() } } : {}),
  });
  recordUpdateRunStep(run.runId, {
    step: "openclaw doctor",
    status: postCore ? "completed" : "in_progress",
  });
  if (postCore) {
    recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  withDatabase(pathname, false, (db) => {
    restoreEmptyV21StorageForHistoricalFixture(db);
    removeCanonicalValidationFromHistoricalAgentFixture(db);
    db.exec(`
      DROP TABLE session_transcript_cold_archives;
      PRAGMA user_version = 19;
      UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
      INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
        VALUES ('upgrade-proof','retained','{"keep":true}',NULL,7);
    `);
  });
  return {
    runId: run.runId,
    pathname,
    bytes: fs.readFileSync(pathname),
    schemas: await prepareDoctorDatabasePreflight(),
  };
}

it("rehearses shared-only schema changes before the shipped package rollback is discarded", async () => {
  await withLegacyAgent(false, async (f) => {
    const pathname = resolveOpenClawStateSqlitePath();
    withDatabase(pathname, false, (database) => {
      database.exec(`PRAGMA user_version = 15;
        DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
    });
    const schemas = await prepareDoctorDatabasePreflight({ scope: "state" });
    expect(schemas.pendingMigrations).toContainEqual(
      expect.objectContaining({ kind: "state", path: pathname, foundVersion: 15 }),
    );
    const before = fs.readFileSync(pathname);
    expect(await guardUpdateDoctorSchemaUpgrade({ schemas })).toMatchObject({
      updateSchemaRehearsal: { runId: f.runId, updaterVersion: "2026.9.2" },
    });
    expect(fs.readFileSync(pathname)).toEqual(before);
  });
});

it.each(["ordinary", "flag-only", "candidate", "rehearsal"])(
  "protects older service state while admitting authorized %s Doctor migration",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await legacyAgentFixture(true, VERSION);
      const { db, path: pathname } = openOpenClawStateDatabase();
      if (mode !== "ordinary") {
        db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
          DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';`);
        revokeSqliteDatabaseAdmissions(requireNativeSqliteDatabase(db));
      }
      await closeStateDatabaseForTest();
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", mode === "candidate" ? f.runId : undefined);
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", mode === "ordinary" ? undefined : "1");
      if (mode === "rehearsal") {
        stubRehearsalEnv(fs.realpathSync(resolveStateDir()));
      }
      const before = fs.readFileSync(pathname);
      const installation = {
        root: "/old",
        version: "2026.10.3",
        cliVersion: VERSION,
        databasePath: pathname,
      };
      const doctor = withGatewayServiceInstallation({ installation }, async () => {
        await preflightUpdateDoctorCli({});
        await withStateMigrationBackupForTest({}, () => openOpenClawStateDatabase());
      });
      if (mode === "ordinary" || mode === "flag-only") {
        await expect(doctor).rejects.toThrow(/Gateway service runs 2026\.10\.3/u);
        expect(fs.readFileSync(pathname)).toEqual(before);
        expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
      } else {
        await doctor;
        withDatabase(pathname, true, (migrated) =>
          expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          }),
        );
      }
    });
  },
);

const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

type DoctorMaintenance = NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>;
async function withDoctorMaintenance(
  options: Partial<Pick<DoctorMaintenanceParams, "runtime" | "assertCurrent">>,
  run: (maintenance: DoctorMaintenance) => Promise<void>,
) {
  await using cleanup = new AsyncDisposableStack();
  const maintenance = await beginDoctorMaintenance({
    root: null,
    options: { repair: true },
    runtime: runtime(),
    ...options,
  });
  cleanup.defer(async () => maintenance?.release());
  await run(expectDefined(maintenance, "Doctor maintenance"));
}

it("stops pre-migration backup production when Doctor accepts SIGINT", async () => {
  const signal = "SIGINT";
  let signalDrain: Promise<void> | undefined;
  try {
    await withLegacyAgent(true, async (f, state) => {
      const payload = path.join(state.stateDir, "synthetic-backup-payload.txt");
      fs.writeFileSync(payload, "synthetic retained source\n");
      fs.truncateSync(payload, 8 * 1024 * 1024);
      const expectUnchanged = captureBytes([f.pathname, state.configPath, payload]);
      const scratch = state.path("backup-scratch");
      fs.mkdirSync(scratch);
      for (const name of ["TMPDIR", "TMP", "TEMP"]) {
        vi.stubEnv(name, scratch);
      }
      const open = fsAsync.open;
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let archiveReads = 0;
      vi.spyOn(fsAsync, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === payload) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            const result = await read(...readArgs);
            if (result.bytesRead >= 1024 * 1024) {
              source = handle;
              archiveReads += 1;
              if (archiveReads === 1) {
                signalDrain = waitForSignalExitBarriers(signal);
              }
            }
            return result;
          });
        }
        return handle;
      });
      const onVerifiedBackup = vi.fn();
      await withDoctorMaintenance({}, async (maintenance) => {
        const options = {
          ...repairOptions(f),
          signal: maintenance.signal,
          onVerifiedBackup,
        };
        const result = await maintenance
          .run(() => guardUpdateDoctorSchemaUpgrade(options))
          .catch((error: unknown) => error);
        expect(archiveReads).toBe(1);
        expect(result).toBeInstanceOf(Error);
        await expect(
          expectDefined(source, "actual backup source handle").read(Buffer.alloc(1), 0, 1, 0),
        ).rejects.toMatchObject({ code: "EBADF" });
        expect(onVerifiedBackup).not.toHaveBeenCalled();
      });
      expect(fs.readdirSync(resolveUpdateCaptureRoot(state.stateDir))).toEqual([]);
      expect(fs.readdirSync(scratch).filter((name) => name.startsWith("openclaw-backup-"))).toEqual(
        [],
      );
      expectUnchanged();
      withDatabase(f.pathname, true, (database) => {
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
      });
    });
  } finally {
    await signalDrain;
    await waitForCliSignalExit();
  }
});

type AdmissionCase = {
  name: string;
  postCore?: true;
  claim?: true | "different";
  maintenance?: true;
  marker?: "missing writable" | "post-core";
};

it.each<AdmissionCase>([
  { name: "private rehearsal" },
  { name: "missing writable marker", marker: "missing writable" },
  { name: "forged post-core marker", marker: "post-core" },
  { name: "post-core without claim or maintenance", postCore: true },
  { name: "post-core claim without maintenance", postCore: true, claim: true },
  { name: "rollback-phase claim", claim: true, maintenance: true, marker: "post-core" },
  {
    name: "different-update claim",
    postCore: true,
    claim: "different",
    maintenance: true,
    marker: "post-core",
  },
])("preserves live agent bytes during $name admission", async (scenario) => {
  await withLegacyAgent(scenario.postCore === true, async (f) => {
    if (scenario.marker) {
      vi.stubEnv(
        scenario.marker === "missing writable"
          ? "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"
          : "OPENCLAW_UPDATE_POST_CORE",
        scenario.marker === "missing writable" ? undefined : "1",
      );
    }
    const admit = () =>
      guardUpdateDoctorSchemaUpgrade({
        schemas: f.schemas,
        ...(scenario.claim
          ? {
              postCoreSchemaRepair: {
                runId: scenario.claim === "different" ? "different-update" : f.runId,
                assertCurrent() {},
              },
            }
          : {}),
      });
    if (scenario.maintenance) {
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      await withDoctorMaintenance({}, async (maintenance) => {
        await expect(maintenance.run(admit)).rejects.toMatchObject({
          code: "update-schema-bump-unfenced",
        });
        expect(create).not.toHaveBeenCalled();
      });
    } else if (scenario.postCore) {
      const refusal = admit();
      await expect(refusal).rejects.toMatchObject({
        code: "update-schema-bump-unfenced",
        message: expect.stringContaining("already committed its package"),
        commands: ["openclaw doctor --fix", "openclaw gateway start"],
      });
      await expect(refusal).rejects.not.toThrow("Let the updater restore");
    } else if (scenario.marker) {
      await expect(admit()).rejects.toMatchObject({ code: "update-schema-bump-unfenced" });
    } else {
      expect(await admit()).toMatchObject({
        updateSchemaRehearsal: { runId: f.runId, updaterVersion: "2026.9.2" },
      });
    }
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
  });
});

it("retains a verified canonical backup before permitting the normal schema migration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    const logs = runtime();
    const create = vi.spyOn(backupCreate, "createBackupArchive");
    const verify = vi.spyOn(backupVerify, "verifyBackupArchive");
    const onVerifiedBackup = vi.fn();
    const authority = { runId: f.runId, assertCurrent: vi.fn() };
    await withDoctorMaintenance(
      { runtime: logs, assertCurrent: authority.assertCurrent },
      async (maintenance) => {
        expect(maintenance).toBeDefined();
        await maintenance.run(async () => {
          await guardUpdateDoctorSchemaUpgrade({
            schemas: f.schemas,
            runtime: logs,
            postCoreSchemaRepair: authority,
            onVerifiedBackup,
          });
          expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
          expect(verify).toHaveBeenCalledTimes(1);
          const identity = fs.statSync(f.pathname, { bigint: true });
          expect(onVerifiedBackup).toHaveBeenCalledExactlyOnceWith([
            expect.objectContaining({
              role: "agent",
              agentId: "main",
              dev: identity.dev,
              ino: identity.ino,
            }),
          ]);
          await migrateAgent(f.pathname, state.env);
          // A current maintenance owner may publish a same-version rebuilt image
          // after migration; the old backup cannot fence unrelated later repairs.
          await withAgentDatabaseMaintenanceLease({ env: state.env }, async (lease) => {
            const before = fs.statSync(f.pathname);
            replaceFileAtomicSync({
              filePath: f.pathname,
              content: fs.readFileSync(f.pathname),
              preserveExistingMode: true,
              beforeRename: () => lease.assertOwned(),
            });
            expect(fs.statSync(f.pathname).ino).not.toBe(before.ino);
            await migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "main", pathname: f.pathname },
              lease,
            );
          });
        });
      },
    );
    const backup = await expectDefined(create.mock.results[0], "canonical backup creation result")
      .value;
    expect(fs.existsSync(backup.archivePath)).toBe(true);
    const facts = expectDefined(verify.mock.calls[0]?.[1], "verified archive coverage");
    const expectUnchanged = captureBytes([f.pathname]);
    await expect(
      backupVerify.verifyBackupArchive(backup.archivePath, facts),
    ).resolves.toMatchObject({ ok: true });
    const agent = expectDefined(
      facts.find((fact) => fact.role === "agent"),
      "captured agent coverage",
    );
    for (const wrong of [
      { ...agent, sourcePath: `${agent.sourcePath}.missing` },
      { ...agent, agentId: "another-agent" },
    ]) {
      await expect(backupVerify.verifyBackupArchive(backup.archivePath, [wrong])).rejects.toThrow(
        "lacks verified SQLite database coverage",
      );
    }
    expectUnchanged();
    using db = new DatabaseSync(f.pathname, { readOnly: true });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(db.prepare("SELECT value_json,updated_at FROM cache_entries").all()).toEqual([
      { value_json: '{"keep":true}', updated_at: 7 },
    ]);
  });
});

it.each([
  ["backup failed", "backup verification failed"],
  ["owner retired during backup", "retired update owner"],
  ["update canceled during backup", "update canceled"],
  ["agent path replaced during backup", "changed physical identity"],
  ["owner retired during integrity", "failed to verify"],
])("keeps live agent bytes when %s", async (mode, message) => {
  await withLegacyAgent(true, async (f, state) => {
    let active = true;
    const retired = new Error("retired update owner");
    const onVerifiedBackup = vi.fn();
    const canceled = new AbortController();
    const assertCurrent = () => {
      canceled.signal.throwIfAborted();
      if (!active) {
        throw retired;
      }
    };
    const verifyArchive = backupVerify.verifyBackupArchive;
    vi.spyOn(backupVerify, "verifyBackupArchive").mockImplementation(async (...args) => {
      if (mode === "backup failed") {
        throw new Error("backup verification failed");
      }
      const verified = await verifyArchive(...args);
      if (mode === "agent path replaced during backup") {
        replaceAgent(f.pathname);
      } else if (mode === "update canceled during backup") {
        canceled.abort(new Error("update canceled"));
      } else {
        active = false;
      }
      return verified;
    });
    const check = integrity.assertSqliteIntegrityInWorker;
    vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
      await check(...args);
      if (mode === "owner retired during integrity" && args[0] === f.pathname) {
        active = false;
      }
    });
    await withDoctorMaintenance({ assertCurrent }, async (maintenance) => {
      const refusal = await maintenance
        .run(() =>
          mode === "owner retired during integrity"
            ? migrateAgent(f.pathname, state.env)
            : guardUpdateDoctorSchemaUpgrade({
                ...repairOptions(f, assertCurrent),
                onVerifiedBackup,
              }),
        )
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(refusal).toMatchObject({ message: expect.stringContaining(message) });
      if (mode === "owner retired during integrity") {
        expect(collectNestedErrorCandidates(refusal)).toContain(retired);
      }
    });
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
    expect(onVerifiedBackup).not.toHaveBeenCalled();
  });
});

it("refuses early unregistered WAL state and admits post-core repair after verified capture", async () => {
  await withLegacyAgent(false, async (f, state) => {
    unregisterOpenClawAgentDatabase({ agentId: "main", path: f.pathname });
    await closeStateDatabaseForTest();
    const agentDir = state.path("external-agent");
    fs.mkdirSync(agentDir);
    const pathname = state.path("external-agent", "openclaw-agent.sqlite");
    fs.renameSync(f.pathname, pathname);
    await state.writeConfig({
      plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { main: { agentDir } } },
    });
    using db = new DatabaseSync(pathname);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
          VALUES ('upgrade-proof','wal-only','{"durable":true}',NULL,8);`);
    expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(32);
    // Online SQLite readers can update SHM read marks; DB/WAL/config are the
    // durable input bytes, and the WAL-only row below must remain readable.
    const expectUnchanged = captureBytes([pathname, `${pathname}-wal`, state.configPath]);
    const schemas = await prepareDoctorDatabasePreflight();
    await expect(guardUpdateDoctorSchemaUpgrade({ schemas })).rejects.toThrow(
      "Missing recoverable database backup coverage",
    );
    expectUnchanged();
    recordUpdateRunStep(f.runId, { step: "openclaw doctor", status: "completed" });
    recordUpdateRunStep(f.runId, { step: "post-update verification", status: "in_progress" });
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
    const create = vi.spyOn(backupCreate, "createBackupArchive");
    await withDoctorMaintenance({}, async (maintenance) => {
      await expect(
        maintenance.run(() =>
          guardUpdateDoctorSchemaUpgrade({
            ...repairOptions(f),
            schemas,
          }),
        ),
      ).resolves.toMatchObject({
        pendingMigrations: [
          {
            kind: "agent",
            agentId: "main",
            path: pathname,
            foundVersion: 19,
            supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        ],
      });
    });
    const archive = await expectDefined(create.mock.results[0], "canonical backup creation").value;
    const restoredRoot = state.path("restored");
    await backupRestoreCommand(runtime(), { archive: archive.archivePath, target: restoredRoot });
    const restoredPath = path.join(
      restoredRoot,
      buildBackupArchivePath(archive.archiveRoot, pathname),
    );
    withDatabase(restoredPath, true, (restored) => {
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
      expect(
        restored.prepare("SELECT key,value_json FROM cache_entries ORDER BY key").all(),
      ).toEqual([
        { key: "retained", value_json: '{"keep":true}' },
        { key: "wal-only", value_json: '{"durable":true}' },
      ]);
    });
    expect(fs.existsSync(`${restoredPath}-wal`)).toBe(false);
    expectUnchanged();
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
    expect(db.prepare("SELECT value_json FROM cache_entries WHERE key='wal-only'").get()).toEqual({
      value_json: '{"durable":true}',
    });
  });
});

it("keeps verified backup identity bound until the actual agent schema write", async () => {
  await withLegacyAgent(true, async (f, state) => {
    const assertCurrent = () => {};
    await withDoctorMaintenance({ assertCurrent }, async (maintenance) => {
      await maintenance.run(async () => {
        await guardUpdateDoctorSchemaUpgrade(repairOptions(f, assertCurrent));
        replaceAgent(f.pathname);
        const replacement = fs.readFileSync(f.pathname);
        await expect(migrateAgent(f.pathname, state.env)).rejects.toThrow("physical identity");
        expect(fs.readFileSync(f.pathname)).toEqual(replacement);
      });
    });
  });
});

it.each([false, true])(
  "keeps publication-only admission nonmutating without granting agent repair (supplied facts=%s)",
  async (supplied) => {
    await withLegacyAgent(true, async (f, state) => {
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      const onVerifiedBackup = vi.fn();
      const expectUnchanged = captureBytes([
        f.pathname,
        resolveOpenClawStateSqlitePath(),
        state.configPath,
      ]);
      const result = await guardUpdateDoctorSchemaUpgrade({
        ...(supplied ? { schemas: f.schemas } : {}),
        statePublicationOnly: true,
        onVerifiedBackup,
      });
      expect(result).toBeDefined();
      expect(create).not.toHaveBeenCalled();
      expect(onVerifiedBackup).not.toHaveBeenCalled();
      expectUnchanged();
      // A diagnostic success is not authority for the subsequent live migration.
      await expect(guardUpdateDoctorSchemaUpgrade({ schemas: f.schemas })).rejects.toMatchObject({
        code: "update-schema-bump-unfenced",
      });
      expectUnchanged();
    });
  },
);

it.each(["owned", "flag-only", "changed namespace", "released owner", "replaced database"])(
  "binds schema exemption to actual disposable rehearsal coverage: %s",
  async (mode) => {
    await withLegacyAgent(true, async (f) => {
      const stateDir = fs.realpathSync(resolveStateDir());
      const bytes = fs.readFileSync(f.pathname);
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      stubRehearsalEnv(stateDir);
      if (mode === "flag-only") {
        vi.stubEnv("TMPDIR", path.dirname(stateDir));
      }
      const owner = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath() });
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      const snapshot = sqliteSnapshot.prepareSqliteReadOnlyLocation;
      vi.spyOn(sqliteSnapshot, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (...args) => {
          const prepared = await snapshot(...args);
          if (mode === "changed namespace") {
            vi.stubEnv("TMPDIR", path.dirname(stateDir));
          } else if (mode === "released owner") {
            owner.release();
          } else if (mode === "replaced database") {
            replaceAgent(f.pathname);
          }
          return prepared;
        },
      );
      try {
        const admission = maintenance.run(() =>
          guardUpdateDoctorSchemaUpgrade({ schemas: f.schemas }),
        );
        if (mode === "owned") {
          expect(await admission).toBe(f.schemas);
        } else if (mode === "flag-only") {
          await expect(admission).rejects.toMatchObject({ code: "update-schema-bump-unfenced" });
        } else {
          await expect(admission).rejects.toThrow(
            mode === "changed namespace"
              ? /namespace changed/
              : mode === "replaced database"
                ? /identity changed/
                : /released|current|owner/i,
          );
        }
        expect(create).not.toHaveBeenCalled();
        expect(fs.readFileSync(f.pathname)).toEqual(bytes);
      } finally {
        await maintenance.close();
        owner.release();
      }
    });
  },
);

it("retains disposable coverage through the real migration of a mixed backed-up fleet", async () => {
  await withLegacyAgent(true, async (f, state) => {
    const externalDir = state.path("external-agent");
    fs.mkdirSync(externalDir);
    const external = openOpenClawAgentDatabase({
      agentId: "external",
      path: path.join(externalDir, "openclaw-agent.sqlite"),
    }).path;
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    fs.unlinkSync(external);
    withDatabase(external, false, (database) => {
      database.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
      database.exec(`PRAGMA user_version = 24;
        INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'agent', 24, 'external', '2026.9.9', 1, 1)`);
    });
    await state.writeConfig({
      plugins: { enabled: false },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, external: { agentDir: externalDir } },
      },
    });
    await closeStateDatabaseForTest();
    const schemas = await prepareDoctorDatabasePreflight();
    expect(schemas.pendingMigrations?.filter((entry) => entry.kind === "agent")).toHaveLength(2);
    const beforeExternal = fs.readFileSync(external);
    stubRehearsalEnv(fs.realpathSync(state.stateDir));
    const onVerifiedBackup = vi.fn();
    await withDoctorMaintenance({}, async (maintenance) => {
      await maintenance.run(async () => {
        const scope = expectDefined(
          getOpenClawDatabaseMaintenanceScope(),
          "native maintenance scope",
        );
        await guardUpdateDoctorSchemaUpgrade({
          ...repairOptions(f, () => scope.assertOwnerCurrent()),
          schemas,
          onVerifiedBackup,
        });
        expect(onVerifiedBackup).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({ role: "agent", agentId: "external" }),
        ]);
        await migrateAgent(f.pathname, process.env);
      });
    });
    withDatabase(f.pathname, true, (migrated) => {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        migrated.prepare("SELECT value_json FROM cache_entries WHERE key='retained'").get(),
      ).toEqual({ value_json: '{"keep":true}' });
    });
    expect(fs.readFileSync(external)).toEqual(beforeExternal);
  });
});
