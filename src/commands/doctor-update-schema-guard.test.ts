import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { resolveStateDir } from "../config/paths.js";
import * as backupCreate from "../infra/backup-create.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as integrity from "../infra/sqlite-integrity-worker.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot-source.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
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
import {
  createOpenClawDatabaseMaintenanceScope,
  getOpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { buildBackupArchivePath } from "./backup-shared.js";
import * as backupVerify from "./backup-verify.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import type { DoctorMaintenanceParams } from "./doctor-maintenance-types.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { guardUpdateDoctorSchemaUpgrade } from "./doctor-update-schema-guard.js";

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

async function legacyAgentFixture(postCore: boolean) {
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
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
  const agent = openOpenClawAgentDatabase({ agentId: "main" });
  const pathname = agent.path;
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
  recordUpdateRunStep(run.runId, {
    step: "openclaw doctor",
    status: postCore ? "completed" : "in_progress",
  });
  if (postCore) {
    recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
  const db = new DatabaseSync(pathname);
  try {
    restoreEmptyV21StorageForHistoricalFixture(db);
    removeCanonicalValidationFromHistoricalAgentFixture(db);
    db.exec(`
      DROP TABLE session_transcript_cold_archives;
      PRAGMA user_version = 19;
      UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
      INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
        VALUES ('upgrade-proof','retained','{"keep":true}',NULL,7);
    `);
  } finally {
    db.close();
  }
  return {
    runId: run.runId,
    pathname,
    bytes: fs.readFileSync(pathname),
    schemas: await prepareDoctorDatabasePreflight(),
  };
}

const runtime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

async function withDoctorMaintenance(
  options: Partial<Pick<DoctorMaintenanceParams, "runtime" | "assertCurrent">>,
  run: (
    maintenance: NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>,
  ) => Promise<void>,
) {
  const maintenance = await beginDoctorMaintenance({
    root: null,
    options: { repair: true },
    runtime: runtime(),
    ...options,
  });
  try {
    await run(expectDefined(maintenance, "Doctor maintenance"));
  } finally {
    await maintenance?.release();
  }
}

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
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await legacyAgentFixture(scenario.postCore === true);
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
          const identity = fs.statSync(f.pathname);
          expect(onVerifiedBackup).toHaveBeenCalledExactlyOnceWith([
            expect.objectContaining({
              role: "agent",
              agentId: "main",
              dev: identity.dev,
              ino: identity.ino,
            }),
          ]);
          await withAgentDatabaseMaintenanceLease({ env: state.env }, (lease) =>
            migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "main", pathname: f.pathname },
              lease,
            ),
          );
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
    const db = new DatabaseSync(f.pathname, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT value_json,updated_at FROM cache_entries").all()).toEqual([
        { value_json: '{"keep":true}', updated_at: 7 },
      ]);
    } finally {
      db.close();
    }
  });
});

it.each([
  "backup failed",
  "owner retired during backup",
  "update canceled during backup",
  "agent path replaced during backup",
])("keeps live agent bytes when %s", async (mode) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await legacyAgentFixture(true);
    let active = true;
    const onVerifiedBackup = vi.fn();
    const canceled = new AbortController();
    const assertCurrent = () => {
      canceled.signal.throwIfAborted();
      if (!active) {
        throw new Error("retired update owner");
      }
    };
    const verifyArchive = backupVerify.verifyBackupArchive;
    vi.spyOn(backupVerify, "verifyBackupArchive").mockImplementation(async (...args) => {
      if (mode === "backup failed") {
        throw new Error("backup verification failed");
      }
      const verified = await verifyArchive(...args);
      if (mode === "agent path replaced during backup") {
        fs.renameSync(f.pathname, `${f.pathname}.previous`);
        fs.copyFileSync(`${f.pathname}.previous`, f.pathname);
      } else if (mode === "update canceled during backup") {
        canceled.abort(new Error("update canceled"));
      } else {
        active = false;
      }
      return verified;
    });
    await withDoctorMaintenance({ assertCurrent }, async (maintenance) => {
      await expect(
        maintenance.run(() =>
          guardUpdateDoctorSchemaUpgrade({
            schemas: f.schemas,
            postCoreSchemaRepair: { runId: f.runId, assertCurrent },
            onVerifiedBackup,
          }),
        ),
      ).rejects.toThrow(
        mode === "backup failed"
          ? "backup verification failed"
          : mode === "update canceled during backup"
            ? "update canceled"
            : mode === "agent path replaced during backup"
              ? "changed physical identity"
              : "retired update owner",
      );
    });
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
    expect(onVerifiedBackup).not.toHaveBeenCalled();
  });
});

it("revalidates the update owner after integrity work before committing an agent schema bump", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    let active = true;
    const retired = new Error("retired update owner");
    const assertCurrent = () => {
      if (!active) {
        throw retired;
      }
    };
    const check = integrity.assertSqliteIntegrityInWorker;
    vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
      await check(...args);
      if (args[0] === f.pathname) {
        active = false;
      }
    });
    await withDoctorMaintenance({ assertCurrent }, async (maintenance) => {
      const result = await Promise.allSettled([
        maintenance.run(() =>
          withAgentDatabaseMaintenanceLease({ env: state.env }, (lease) =>
            migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "main", pathname: f.pathname },
              lease,
            ),
          ),
        ),
      ]);
      const outcome = expectDefined(result[0], "migration outcome");
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Expected retired owner refusal");
      }
      expect(collectNestedErrorCandidates(outcome.reason)).toContain(retired);
    });
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
  });
});

it("refuses early unregistered WAL state and admits post-core repair after verified capture", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(false);
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
    const db = new DatabaseSync(pathname);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at)
          VALUES ('upgrade-proof','wal-only','{"durable":true}',NULL,8);`);
      expect(fs.statSync(`${pathname}-wal`).size).toBeGreaterThan(32);
      // Online SQLite readers can update SHM read marks; DB/WAL/config are the
      // durable input bytes, and the WAL-only row below must remain readable.
      const files = [pathname, `${pathname}-wal`, state.configPath];
      const before = files.map((file) => fs.readFileSync(file));
      const schemas = await prepareDoctorDatabasePreflight();
      await expect(guardUpdateDoctorSchemaUpgrade({ schemas })).rejects.toThrow(
        "Missing recoverable canonical backup coverage",
      );
      expect(
        files.map((file) => fs.readFileSync(file)),
        JSON.stringify(
          files.filter(
            (file, index) =>
              !fs.readFileSync(file).equals(expectDefined(before[index], "original source bytes")),
          ),
        ),
      ).toEqual(before);
      recordUpdateRunStep(f.runId, { step: "openclaw doctor", status: "completed" });
      recordUpdateRunStep(f.runId, { step: "post-update verification", status: "in_progress" });
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      await withDoctorMaintenance({}, async (maintenance) => {
        await expect(
          maintenance.run(() =>
            guardUpdateDoctorSchemaUpgrade({
              schemas,
              postCoreSchemaRepair: { runId: f.runId, assertCurrent() {} },
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
      const archive = await expectDefined(create.mock.results[0], "canonical backup creation")
        .value;
      const restoredRoot = state.path("restored");
      await backupRestoreCommand(runtime(), { archive: archive.archivePath, target: restoredRoot });
      const restoredPath = path.join(
        restoredRoot,
        buildBackupArchivePath(archive.archiveRoot, pathname),
      );
      const restored = new DatabaseSync(restoredPath, { readOnly: true });
      try {
        expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
        expect(
          restored.prepare("SELECT key,value_json FROM cache_entries ORDER BY key").all(),
        ).toEqual([
          { key: "retained", value_json: '{"keep":true}' },
          { key: "wal-only", value_json: '{"durable":true}' },
        ]);
      } finally {
        restored.close();
      }
      expect(fs.existsSync(`${restoredPath}-wal`)).toBe(false);
      expect(
        files.map((file) => fs.readFileSync(file)),
        JSON.stringify(
          files.filter(
            (file, index) =>
              !fs.readFileSync(file).equals(expectDefined(before[index], "original source bytes")),
          ),
        ),
      ).toEqual(before);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
      expect(db.prepare("SELECT value_json FROM cache_entries WHERE key='wal-only'").get()).toEqual(
        {
          value_json: '{"durable":true}',
        },
      );
    } finally {
      db.close();
    }
  });
});

it("requires the captured agent path and owner to be verified canonical archive entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    let facts: readonly BackupSqliteSnapshotFact[] = [];
    const archive = await backupCreate.createBackupArchive({
      output: state.path("coverage.tar.gz"),
      includeWorkspace: false,
      onSqliteSnapshots: (captured) => {
        facts = captured;
      },
    });
    const agents = facts.filter((fact) => fact.role === "agent");
    expect(agents).toHaveLength(1);
    await expect(
      backupVerify.verifyBackupArchive(archive.archivePath, facts),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      backupVerify.verifyBackupArchive(
        archive.archivePath,
        agents.map((fact) => Object.assign({}, fact, { sourcePath: `${fact.sourcePath}.missing` })),
      ),
    ).rejects.toThrow("lacks verified canonical SQLite coverage");
    await expect(
      backupVerify.verifyBackupArchive(
        archive.archivePath,
        agents.map((fact) => Object.assign({}, fact, { agentId: "another-agent" })),
      ),
    ).rejects.toThrow("lacks verified canonical SQLite coverage");
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
  });
});

it("keeps verified backup identity bound until the actual agent schema write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    const assertCurrent = () => {};
    await withDoctorMaintenance({ assertCurrent }, async (maintenance) => {
      await maintenance.run(async () => {
        await guardUpdateDoctorSchemaUpgrade({
          schemas: f.schemas,
          postCoreSchemaRepair: { runId: f.runId, assertCurrent },
        });
        fs.renameSync(f.pathname, `${f.pathname}.before-replacement`);
        fs.copyFileSync(`${f.pathname}.before-replacement`, f.pathname);
        const replacement = fs.readFileSync(f.pathname);
        await expect(
          withAgentDatabaseMaintenanceLease({ env: state.env }, (lease) =>
            migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "main", pathname: f.pathname },
              lease,
            ),
          ),
        ).rejects.toThrow("physical identity");
        expect(fs.readFileSync(f.pathname)).toEqual(replacement);
      });
    });
  });
});

it.each([false, true])(
  "keeps publication-only admission nonmutating without granting agent repair (supplied facts=%s)",
  async (supplied) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await legacyAgentFixture(true);
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      const onVerifiedBackup = vi.fn();
      const files = [f.pathname, resolveOpenClawStateSqlitePath(), state.configPath];
      const before = files.map((filename) => fs.readFileSync(filename));
      const result = await guardUpdateDoctorSchemaUpgrade({
        ...(supplied ? { schemas: f.schemas } : {}),
        statePublicationOnly: true,
        onVerifiedBackup,
      });
      expect(result).toBeDefined();
      expect(create).not.toHaveBeenCalled();
      expect(onVerifiedBackup).not.toHaveBeenCalled();
      expect(files.map((filename) => fs.readFileSync(filename))).toEqual(before);
      // A diagnostic success is not authority for the subsequent live migration.
      await expect(guardUpdateDoctorSchemaUpgrade({ schemas: f.schemas })).rejects.toMatchObject({
        code: "update-schema-bump-unfenced",
      });
      expect(files.map((filename) => fs.readFileSync(filename))).toEqual(before);
    });
  },
);

it.each(["owned", "flag-only", "changed namespace", "released owner", "replaced database"])(
  "binds schema exemption to actual disposable rehearsal coverage: %s",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await legacyAgentFixture(true);
      const stateDir = fs.realpathSync(resolveStateDir());
      const bytes = fs.readFileSync(f.pathname);
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      for (const [key, value] of Object.entries(buildUpdateRehearsalPathEnv(stateDir))) {
        vi.stubEnv(key, value);
      }
      vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
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
            fs.renameSync(f.pathname, `${f.pathname}.original`);
            fs.copyFileSync(`${f.pathname}.original`, f.pathname);
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    const externalDir = state.path("external-agent");
    fs.mkdirSync(externalDir);
    const external = openOpenClawAgentDatabase({
      agentId: "external",
      path: path.join(externalDir, "openclaw-agent.sqlite"),
    }).path;
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    const database = new DatabaseSync(external);
    try {
      database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
      database
        .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
        .run(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
    } finally {
      database.close();
    }
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
    for (const [key, value] of Object.entries(
      buildUpdateRehearsalPathEnv(fs.realpathSync(state.stateDir)),
    )) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
    const onVerifiedBackup = vi.fn();
    await withDoctorMaintenance({}, async (maintenance) => {
      await maintenance.run(async () => {
        const scope = expectDefined(
          getOpenClawDatabaseMaintenanceScope(),
          "native maintenance scope",
        );
        await guardUpdateDoctorSchemaUpgrade({
          schemas,
          postCoreSchemaRepair: { runId: f.runId, assertCurrent: () => scope.assertOwnerCurrent() },
          onVerifiedBackup,
        });
        expect(onVerifiedBackup).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({ role: "agent", agentId: "external" }),
        ]);
        await withAgentDatabaseMaintenanceLease({ env: process.env }, (lease) =>
          migrateOpenClawAgentDatabaseForMaintenance(
            { agentId: "main", pathname: f.pathname },
            lease,
          ),
        );
      });
    });
    const migrated = new DatabaseSync(f.pathname, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        migrated.prepare("SELECT value_json FROM cache_entries WHERE key='retained'").get(),
      ).toEqual({ value_json: '{"keep":true}' });
    } finally {
      migrated.close();
    }
    expect(fs.readFileSync(external)).toEqual(beforeExternal);
  });
});
