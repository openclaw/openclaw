import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { parseBackupManifest, type BackupManifest } from "../commands/backup-verify-manifest.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import { createDoctorOriginalCaptureHook } from "../commands/doctor-original-capture-admission.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  executeCanonicalStateSchema,
  writeCurrentStateSchemaMetadata,
} from "../state/openclaw-state-db-maintenance.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  bindFreshClientCredentialStore,
  prepareClientCredentialMigration,
  recoverClientCredentialStore,
} from "./client-credential-migration.js";
import { openMigrationCredentials } from "./client-credential-migration.test-support.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import type { ClientCredentialReceipt } from "./client-credential-receipt.js";
import { prepareRestoredClientCredentials } from "./client-credential-restore.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";

function createIdentity(env: NodeJS.ProcessEnv, timestamp: number) {
  const identity = generateStoredDeviceIdentity(timestamp);
  runClientCredentialOperation(env, {
    kind: "identity.create",
    identity: storedDeviceIdentityToRow("primary", identity, timestamp),
  });
  return identity;
}

describe("whole-archive credential relocation", () => {
  it("preserves interrupted completion through rehearsal until the copied owner recovers", async () => {
    await withOpenClawTestState(
      { layout: "split", scenario: "external-service", label: "credential-rehearsal" },
      async (state) => {
        const identity = createIdentity(state.env, 23);
        const sharedPath = state.statePath("state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(sharedPath), { recursive: true, mode: 0o700 });
        {
          using source = openNodeSqliteDatabase(sharedPath);
          const prototype = requireNodeSqlite().StatementSync.prototype;
          // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its native statement receiver.
          const originalRun = prototype.run;
          let interruptedAfterSourceCommit = false;
          // Inject the write fault after admission without changing the accepted schema.
          const completion = vi.spyOn(prototype, "run").mockImplementation(
            new Proxy(originalRun, {
              apply(run, statement: StatementSync, args) {
                if (
                  statement.sourceSQL.startsWith('insert into "client_credential_migration"') &&
                  args.includes("complete")
                ) {
                  interruptedAfterSourceCommit = !source.isTransaction;
                  throw new Error("fixture completion interrupted");
                }
                return Reflect.apply(run, statement, args);
              },
            }),
          );
          try {
            runSqliteImmediateTransactionSync(source, () => {
              executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
              writeCurrentStateSchemaMetadata(source, 23);
              bindFreshClientCredentialStore(source, { path: sharedPath, env: state.env });
            });
          } finally {
            completion.mockRestore();
          }
          expect(interruptedAfterSourceCommit).toBe(true);
        }
        {
          using local = openMigrationCredentials(state.env);
          expect(readClientCredentialReceipt(local.database)?.phase).toBe("copied");
        }
        const archive = await createBackupArchive({
          output: state.path("interrupted.tar.gz"),
          includeWorkspace: false,
        });
        const archiveTarget = state.path("archive-restore");
        await expect(
          backupRestoreCommand(createTestRuntime(), {
            archive: archive.archivePath,
            target: archiveTarget,
          }),
        ).rejects.toThrow("Backup restore failed; the incomplete target was cleaned");
        expect(fs.existsSync(archiveTarget)).toBe(false);
        const localPath = state.statePath("client", "credentials.sqlite");
        const original = fs.readFileSync(localPath);
        const targetStateDir = state.path("rehearsal");
        const input = {
          stateDir: state.stateDir,
          targetStateDir,
          candidateRoot: process.cwd(),
          config: { plugins: { enabled: false } },
          env: state.env,
          additionalPaths: [],
        };
        const inventory = await readUpdateCandidateStateInventoryInProcess(input);
        await snapshotUpdateCandidateState({
          ...input,
          pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
          databaseInventory: [...inventory.databases.keys()],
        });
        const copiedEnv = { ...state.env, OPENCLAW_STATE_DIR: targetStateDir };
        {
          using local = openMigrationCredentials(copiedEnv);
          expect(readClientCredentialReceipt(local.database)?.phase).toBe("copied");
        }
        const readIdentity = () =>
          runClientCredentialOperation(copiedEnv, {
            kind: "identity.read",
            identity_key: "primary",
          });
        expect(readIdentity).toThrow("migration is incomplete or stale");
        const copiedSharedPath = path.join(targetStateDir, "state", "openclaw.sqlite");
        {
          using copiedShared = openNodeSqliteDatabase(copiedSharedPath);
          recoverClientCredentialStore(copiedShared, {
            path: copiedSharedPath,
            env: copiedEnv,
          });
        }
        expect(readIdentity()).toMatchObject({
          kind: "identity",
          identity: { device_id: identity.deviceId, private_key_pem: identity.privateKeyPem },
        });
        expect(fs.readFileSync(localPath)).toEqual(original);
      },
    );
  });

  it("keeps a local orphan fenced when the matched PostgreSQL export predates cutover", async () => {
    await withOpenClawTestState(
      { layout: "split", scenario: "external-service", label: "credential-pg-restore" },
      async (state) => {
        createIdentity(state.env, 7);
        const sharedPath = state.statePath("state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(sharedPath), { recursive: true, mode: 0o700 });
        {
          using anchor = openNodeSqliteDatabase(sharedPath);
          anchor.exec(
            "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT);" +
              "INSERT INTO openclaw_engine_anchor VALUES ('b3046bb3-bca5-444e-a760-7e6190afc0fd', 'postgres', 'synthetic_state');",
          );
          runSqliteImmediateTransactionSync(anchor, () =>
            bindFreshClientCredentialStore(anchor, { path: sharedPath, env: state.env }),
          );
        }
        {
          using local = openMigrationCredentials(state.env);
          const sharedIdentity = fs.statSync(sharedPath, { bigint: true });
          expect(readClientCredentialReceipt(local.database)).toEqual({
            phase: "complete",
            receipt: {
              format: 1,
              source: {
                kind: "canonical",
                engine: "postgres",
                identity: "b3046bb3-bca5-444e-a760-7e6190afc0fd",
                generation: "bootstrap:b3046bb3-bca5-444e-a760-7e6190afc0fd",
                sha256: "2a7509c68153d6badd47f49bb24209c90adbaee4793ad36669984982f8711ec1",
                destinationVersion: 1,
              },
              sharedFile: {
                path: fs.realpathSync.native(sharedPath),
                dev: String(sharedIdentity.dev),
                ino: String(sharedIdentity.ino),
              },
              legacyImports: {
                "identity:primary": { sha256: null },
                "identity:node": { sha256: null },
                "identity:shareExtension": { sha256: null },
                "auth:primary": { sha256: null },
                "auth:node": { sha256: null },
                "auth:shareExtension": { sha256: null },
              },
            },
          });
        }
        const original = fs.readFileSync(state.statePath("client", "credentials.sqlite"));
        const targetPath = state.path("restored");
        const archiveRoot = "synthetic-archive";
        const stateArchivePath = buildBackupArchivePath(archiveRoot, state.stateDir);
        const restoredStateDir = path.join(targetPath, stateArchivePath);
        const restoredSharedPath = path.join(
          targetPath,
          buildBackupArchivePath(archiveRoot, sharedPath),
        );
        fs.mkdirSync(path.dirname(restoredSharedPath), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(restoredStateDir, "client"), { mode: 0o700 });
        fs.copyFileSync(sharedPath, restoredSharedPath);
        fs.copyFileSync(
          state.statePath("client", "credentials.sqlite"),
          path.join(restoredStateDir, "client", "credentials.sqlite"),
        );
        const exportDirectory = `${restoredSharedPath}.postgres`;
        fs.mkdirSync(exportDirectory, { mode: 0o700 });
        fs.copyFileSync(sharedPath, path.join(exportDirectory, "anchor.sqlite"));
        {
          using image = openNodeSqliteDatabase(path.join(exportDirectory, "database.sqlite"));
          image.exec("PRAGMA user_version = 25");
        }
        const manifest: BackupManifest = {
          schemaVersion: 1,
          createdAt: "2026-10-16T00:00:00.000Z",
          archiveRoot,
          runtimeVersion: "test",
          platform: process.platform,
          nodeVersion: process.version,
          assets: [{ kind: "state", sourcePath: state.stateDir, archivePath: stateArchivePath }],
          sqliteSnapshots: [{ role: "global", sourcePath: sharedPath }],
        };
        prepareRestoredClientCredentials({ manifest, targetPath })?.();
        const restoredEnv = { ...state.env, OPENCLAW_STATE_DIR: restoredStateDir };
        expect(
          fs.readFileSync(path.join(restoredStateDir, "client", "credentials.sqlite")),
        ).toEqual(original);
        expect(() =>
          runClientCredentialOperation(restoredEnv, {
            kind: "identity.read",
            identity_key: "primary",
          }),
        ).toThrow("migration is incomplete or stale");
      },
    );
  });

  it.each([
    { alias: false, mismatch: "none" },
    { alias: false, mismatch: "generation" },
    ...(process.platform === "win32"
      ? []
      : [
          { alias: true, mismatch: "none" },
          { alias: true, mismatch: "capture" },
        ]),
  ])(
    "requires the matched archived shared identity (alias=$alias, mismatch=$mismatch)",
    async ({ alias, mismatch }) => {
      await withOpenClawTestState(
        { layout: "split", scenario: "external-service", label: "credential-restore" },
        async (state) => {
          const identity = generateStoredDeviceIdentity(41);
          const sharedPath = state.statePath("state", "openclaw.sqlite");
          const physicalSharedPath = alias
            ? state.statePath("state", "shared-source.sqlite")
            : sharedPath;
          fs.mkdirSync(path.dirname(sharedPath), { recursive: true, mode: 0o700 });
          if (alias) {
            fs.symlinkSync(path.basename(physicalSharedPath), sharedPath);
          }
          {
            using native = openNodeSqliteDatabase(physicalSharedPath);
            native.exec(
              CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
                0,
                CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE gateway_origin_device_tokens"),
              ),
            );
            native
              .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
              .run(
                "primary",
                identity.deviceId,
                identity.publicKeyPem,
                identity.privateKeyPem,
                41,
                41,
              );
          }
          const runtime = createTestRuntime();
          const maintenance = await beginDoctorMaintenance({
            root: process.cwd(),
            options: { repair: true, nonInteractive: true },
            runtime,
            beforeStateMutation: createDoctorOriginalCaptureHook({
              root: process.cwd(),
              runtime,
              reportFindings: () => {},
            }),
          });
          try {
            await maintenance!.run(() =>
              backupDoctorMigrationDatabases({
                env: state.env,
                pendingDatabasePaths: [sharedPath],
                databasePaths: [sharedPath],
              }),
            );
            const originalName = fs
              .readdirSync(path.dirname(sharedPath))
              .find((name) => name.endsWith(".bak"));
            expect(originalName).toBeDefined();
            using original = openNodeSqliteDatabase(
              path.join(path.dirname(sharedPath), originalName!),
              { readOnly: true },
            );
            expect(original.prepare("SELECT device_id FROM device_identities").get()).toEqual({
              device_id: identity.deviceId,
            });
            // Archive relocation exercises the real restore owner after an explicitly
            // captured fixture migration, not the pending installed-driver hook.
            maintenance!.run(() => {
              const scope = getOpenClawDatabaseMaintenanceScope();
              if (!scope) {
                throw new Error("Expected captured fixture maintenance scope.");
              }
              using source = openNodeSqliteDatabase(sharedPath);
              runSqliteImmediateTransactionSync(source, () => {
                prepareClientCredentialMigration(source, {
                  path: sharedPath,
                  env: state.env,
                  fromVersion: 0,
                  capture: {
                    path: sharedPath,
                    generation: createHash("sha256")
                      .update(fs.readFileSync(path.join(path.dirname(sharedPath), originalName!)))
                      .digest("hex"),
                    assertCurrent: scope.assertAdmission,
                  },
                });
                executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
                writeCurrentStateSchemaMetadata(source, 42);
              });
            });
            maintenance!.run(() => openOpenClawStateDatabase({ env: state.env }));
          } finally {
            await closeOpenClawStateDatabaseAsync();
            await maintenance!.releaseState();
            await maintenance!.release();
          }
          let expectedSource: ClientCredentialReceipt["source"];
          {
            using local = openMigrationCredentials(state.env);
            const stored = readClientCredentialReceipt(local.database)!;
            expect(stored.receipt.source?.engine).toBe("sqlite");
            expectedSource = stored.receipt.source;
            if (mismatch === "generation") {
              stored.receipt.source!.identity = `${sharedPath}:different-generation`;
              runSqliteImmediateTransactionSync(local.database, () =>
                writeClientCredentialReceipt(local.database, stored.receipt, "complete"),
              );
            }
          }
          const backup = await createBackupArchive({
            output: state.path("credentials.tar.gz"),
            includeWorkspace: false,
          });
          let archivePath = backup.archivePath;
          if (mismatch === "capture") {
            const extracted = state.path("mismatched-capture");
            fs.mkdirSync(extracted);
            await tar.x({ file: archivePath, cwd: extracted });
            const manifestPath = path.join(extracted, backup.archiveRoot, "manifest.json");
            const manifest = parseBackupManifest(fs.readFileSync(manifestPath, "utf8"));
            manifest.paths = {
              ...manifest.paths,
              sharedDatabaseSourcePath: state.path("different-shared.sqlite"),
            };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            archivePath = state.path("mismatched.tar.gz");
            await tar.c({ file: archivePath, gzip: true, cwd: extracted }, [backup.archiveRoot]);
          }
          if (alias) {
            // Restore must use captured identity even when neither source spelling exists.
            fs.unlinkSync(sharedPath);
            fs.unlinkSync(physicalSharedPath);
            expect(fs.existsSync(sharedPath)).toBe(false);
            expect(fs.existsSync(physicalSharedPath)).toBe(false);
          }
          const target = state.path("relocated");
          const restore = backupRestoreCommand(runtime, { archive: archivePath, target });
          if (mismatch !== "none") {
            await expect(restore).rejects.toThrow(
              mismatch === "capture"
                ? "Restored client credentials do not match the captured shared database"
                : "Restored client credentials have a different shared database identity",
            );
            expect(fs.existsSync(target)).toBe(false);
            return;
          }
          const restored = await restore;
          const asset = backup.assets.find((entry) => entry.kind === "state")!;
          const activatedStateDir = state.path("activated-state");
          fs.renameSync(path.join(restored.targetPath, asset.archivePath), activatedStateDir);
          const restoredEnv = {
            ...state.env,
            OPENCLAW_STATE_DIR: activatedStateDir,
          };
          const activatedSharedPath = path.join(activatedStateDir, "state", "openclaw.sqlite");
          {
            using shared = openNodeSqliteDatabase(activatedSharedPath);
            recoverClientCredentialStore(shared, { path: activatedSharedPath, env: restoredEnv });
          }
          expect(
            runClientCredentialOperation(restoredEnv, {
              kind: "identity.read",
              identity_key: "primary",
            }),
          ).toEqual({
            kind: "identity",
            identity: storedDeviceIdentityToRow("primary", identity, 41),
          });
          using local = openMigrationCredentials(restoredEnv);
          const relocated = readClientCredentialReceipt(local.database)!;
          expect(relocated.receipt.source).toMatchObject({
            generation: expectedSource!.generation,
            sha256: expectedSource!.sha256,
          });
          expect(relocated.receipt.sharedFile?.path).not.toBe(sharedPath);
          const restoredSharedPath = path.join(
            restoredEnv.OPENCLAW_STATE_DIR,
            "state",
            "openclaw.sqlite",
          );
          const restoredIdentity = fs.statSync(restoredSharedPath, { bigint: true });
          expect(relocated.receipt.sharedFile).toEqual({
            path: fs.realpathSync.native(restoredSharedPath),
            dev: String(restoredIdentity.dev),
            ino: String(restoredIdentity.ino),
          });
        },
      );
    },
  );
});
