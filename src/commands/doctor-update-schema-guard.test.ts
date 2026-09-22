import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import * as backupCreate from "../infra/backup-create.js";
import * as packageRoot from "../infra/openclaw-root.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import * as integrity from "../infra/sqlite-integrity-worker.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  migrateOpenClawAgentDatabaseForMaintenance,
  openOpenClawAgentDatabase,
  withAgentDatabaseMaintenanceLease,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { restoreEmptyV21StorageForHistoricalFixture } from "../state/openclaw-agent-schema-v21.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import type { BackupSqliteSnapshotFact } from "./backup-resource-inventory.js";
import * as backupVerify from "./backup-verify.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
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
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
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

it("admits only private rehearsal while the shipped package validator can roll back", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = await legacyAgentFixture(false);
    expect(await guardUpdateDoctorSchemaUpgrade({ schemas: f.schemas })).toMatchObject({
      updateSchemaRehearsal: { runId: f.runId, updaterVersion: "2026.9.2" },
    });
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
  });
});

it.each(["missing writable marker", "forged post-core marker"])(
  "refuses %s without changing the agent database",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await legacyAgentFixture(false);
      vi.stubEnv(
        mode === "missing writable marker"
          ? "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"
          : "OPENCLAW_UPDATE_POST_CORE",
        mode === "missing writable marker" ? undefined : "1",
      );
      await expect(guardUpdateDoctorSchemaUpgrade({ schemas: f.schemas })).rejects.toMatchObject({
        code: "update-schema-bump-unfenced",
      });
      expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
    });
  },
);

it.each([false, true])(
  "refuses post-core repair without maintenance (claim=%s) with committed-package recovery",
  async (claim) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await legacyAgentFixture(true);
      const refusal = guardUpdateDoctorSchemaUpgrade({
        schemas: f.schemas,
        ...(claim ? { postCoreSchemaRepair: { runId: f.runId, assertCurrent() {} } } : {}),
      });
      await expect(refusal).rejects.toMatchObject({
        code: "update-schema-bump-unfenced",
        message: expect.stringContaining("already committed its package"),
        commands: ["openclaw doctor --fix", "openclaw gateway start"],
      });
      await expect(refusal).rejects.not.toThrow("Let the updater restore");
      expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
    });
  },
);

it.each(["rollback phase", "different update"])(
  "refuses a delegated claim for the %s even under maintenance",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await legacyAgentFixture(mode !== "rollback phase");
      vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", "1");
      const create = vi.spyOn(backupCreate, "createBackupArchive");
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true },
        runtime: runtime(),
      });
      try {
        await expect(
          expectDefined(maintenance, "Doctor maintenance").run(() =>
            guardUpdateDoctorSchemaUpgrade({
              schemas: f.schemas,
              postCoreSchemaRepair: {
                runId: mode === "different update" ? "different-update" : f.runId,
                assertCurrent() {},
              },
            }),
          ),
        ).rejects.toMatchObject({ code: "update-schema-bump-unfenced" });
        expect(create).not.toHaveBeenCalled();
      } finally {
        await maintenance?.release();
      }
      expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
    });
  },
);

it("retains a verified canonical backup before permitting the normal schema migration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(true);
    const logs = runtime();
    const create = vi.spyOn(backupCreate, "createBackupArchive");
    const verify = vi.spyOn(backupVerify, "verifyBackupArchive");
    const authority = { runId: f.runId, assertCurrent: vi.fn() };
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: logs,
      assertCurrent: authority.assertCurrent,
    });
    expect(maintenance).toBeDefined();
    try {
      await expectDefined(maintenance, "Doctor maintenance").run(async () => {
        await guardUpdateDoctorSchemaUpgrade({
          schemas: f.schemas,
          runtime: logs,
          postCoreSchemaRepair: authority,
        });
        expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
        expect(verify).toHaveBeenCalledTimes(1);
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
    } finally {
      await maintenance?.release();
    }
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
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: runtime(),
      assertCurrent,
    });
    try {
      await expect(
        expectDefined(maintenance, "Doctor maintenance").run(() =>
          guardUpdateDoctorSchemaUpgrade({
            schemas: f.schemas,
            postCoreSchemaRepair: { runId: f.runId, assertCurrent },
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
    } finally {
      await maintenance?.release();
    }
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
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
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: runtime(),
      assertCurrent,
    });
    try {
      const result = await Promise.allSettled([
        expectDefined(maintenance, "Doctor maintenance").run(() =>
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
    } finally {
      await maintenance?.release();
    }
    expect(fs.readFileSync(f.pathname)).toEqual(f.bytes);
  });
});

it("refuses configured unregistered WAL state before package commit and before live post-core repair", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await legacyAgentFixture(false);
    unregisterOpenClawAgentDatabase({ agentId: "main", path: f.pathname });
    closeOpenClawStateDatabaseForTest();
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
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true },
        runtime: runtime(),
      });
      try {
        await expect(
          expectDefined(maintenance, "Doctor maintenance").run(() =>
            guardUpdateDoctorSchemaUpgrade({
              schemas,
              postCoreSchemaRepair: { runId: f.runId, assertCurrent() {} },
            }),
          ),
        ).rejects.toThrow("no captured canonical image");
      } finally {
        await maintenance?.release();
      }
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
    const maintenance = await beginDoctorMaintenance({
      root: null,
      options: { repair: true },
      runtime: runtime(),
      assertCurrent,
    });
    try {
      await expectDefined(maintenance, "Doctor maintenance").run(async () => {
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
    } finally {
      await maintenance?.release();
    }
  });
});
