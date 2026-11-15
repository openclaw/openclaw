import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import { createBackupArchive } from "../infra/backup-create.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { capturePortClientCredentialBinding } from "../infra/client-credential-restore.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "../infra/client-credential-store.js";
import { enqueueDelivery } from "../infra/outbound/delivery-queue-storage.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { prepareBackupArchive } from "./backup-verify.js";
import {
  createDatabaseMigrationCapture,
  restoreDatabaseMigrationCapture,
} from "./database-migration-capture.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

let state: OpenClawTestState;
let baseArchive: string;
let selectedStateDir: string;
let witness: string;
let capsule: Awaited<ReturnType<typeof createDatabaseMigrationCapture>>;

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", scenario: "minimal" });
  await state.writeConfig({
    plugins: { enabled: false },
    agents: { entries: { main: { workspace: state.workspaceDir } } },
  });
  const source = openOpenClawStateDatabase({ env: state.env });
  source.db.exec(
    "CREATE TABLE migration_witness(value TEXT); INSERT INTO migration_witness VALUES ('exact retained history');",
  );
  withDaemonRuntimePinStore(state.env, true, (db) => {
    db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
      "migration-pin",
      "retained runtime",
      123,
    );
  });
  runClientCredentialOperation(state.env, {
    kind: "socket.ensure",
    fallback: {
      socket_key: "current",
      socket_path: "/synthetic/native.sock",
      socket_token: "retained-private-token",
      updated_at_ms: 123,
    },
    requested: { token: "retained-private-token" },
  });
  await enqueueDelivery(
    { channel: "matrix", to: "!room:example", payloads: [{ text: "retained send intent" }] },
    state.stateDir,
  );
  witness = path.join(state.workspaceDir, "user.txt");
  await fs.writeFile(witness, "retained workspace bytes");
  await closeOpenClawStateDatabaseAsync();
  baseArchive = (await createBackupArchive({ output: state.path("base.tar.gz"), verify: true }))
    .archivePath;
  selectedStateDir = state.path("selected-state");
  await fs.symlink(
    state.stateDir,
    selectedStateDir,
    process.platform === "win32" ? "junction" : "dir",
  );
});

beforeAll(async () => {
  // Restore cases share an immutable capsule, not a previous test's output.
  capsule = await createDatabaseMigrationCapture({
    baseArchive,
    output: state.path("canonical-capsule"),
  });
});

afterAll(async () => {
  await state?.cleanup();
});

describe("exact database migration capture", () => {
  it("captures the selected physical source through a state-root alias", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: selectedStateDir }, async () => {
      const capture = await createDatabaseMigrationCapture({
        baseArchive,
        output: state.path("aliased-capsule"),
      });
      expect(capture).toMatchObject({
        ok: true,
        profile: "exact-sqlite-migration",
        sourceStateDir: state.stateDir,
      });
      const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
      const global = manifest.databases.find(
        (entry: { sourcePath: string }) =>
          entry.sourcePath === state.statePath("state/openclaw.sqlite"),
      );
      using database = new DatabaseSync(path.join(capture.directory, global.file), {
        readOnly: true,
      });
      expect(database.prepare("SELECT value FROM migration_witness").all()).toEqual([
        { value: "exact retained history" },
      ]);
    });
  });

  it("restores exact data and admits promoted credentials through a state-root alias", async () => {
    const runtime = createTestRuntime();
    const restored = await withEnvAsync({ OPENCLAW_STATE_DIR: selectedStateDir }, () =>
      restoreDatabaseMigrationCapture(runtime, {
        capture: capsule.directory,
        target: state.path("staging"),
        manifestSha256: capsule.manifestSha256,
      }),
    );
    expect(runtime.log).not.toHaveBeenCalled();
    expect(restored.exactMigration).toMatchObject({
      captureId: capsule.captureId,
      sourceStateDir: state.stateDir,
    });
    const staged = (file: string) =>
      path.join(restored.targetPath, buildBackupArchivePath(restored.archiveRoot, file));
    {
      using database = new DatabaseSync(staged(state.statePath("state/openclaw.sqlite")), {
        readOnly: true,
      });
      expect(database.prepare("SELECT value FROM migration_witness").all()).toEqual([
        { value: "exact retained history" },
      ]);
      expect(database.prepare("SELECT entry_json FROM delivery_queue_entries").all()).toEqual([
        expect.objectContaining({ entry_json: expect.stringContaining("retained send intent") }),
      ]);
      using pins = new DatabaseSync(staged(state.statePath("control/services.sqlite")), {
        readOnly: true,
      });
      expect(pins.prepare("SELECT state_key,value_json FROM daemon_runtime_pins").all()).toEqual([
        { state_key: "migration-pin", value_json: "retained runtime" },
      ]);
      using credentials = new DatabaseSync(staged(state.statePath("client/credentials.sqlite")), {
        readOnly: true,
      });
      expect(
        credentials
          .prepare(
            "SELECT socket_token FROM native_exec_socket_credentials WHERE socket_key='current'",
          )
          .get(),
      ).toEqual({ socket_token: "retained-private-token" });
    }
    expect(await fs.readFile(staged(witness), "utf8")).toBe("retained workspace bytes");
    expect(await fs.readFile(witness, "utf8")).toBe("retained workspace bytes");
    const promotedState = state.path("promoted-state");
    await fs.rename(staged(state.stateDir), promotedState);
    const promotedEnv = { ...state.env, OPENCLAW_STATE_DIR: promotedState };
    const promotedShared = path.join(promotedState, "state/openclaw.sqlite");
    const promotedFile = readClientCredentialFileIdentity(promotedShared);
    if (!promotedFile) {
      throw new Error("Promoted synthetic shared store is missing");
    }
    expect(
      capturePortClientCredentialBinding({
        env: promotedEnv,
        sourcePath: promotedShared,
        sourceFile: promotedFile,
      }),
    ).not.toBeNull();
    using admitted = openClientCredentialCustody(promotedEnv, { readOnly: true });
    expect(admitted?.run({ kind: "socket.read" })).toMatchObject({
      kind: "socket",
      socket: { socket_token: "retained-private-token" },
    });
  });

  it("refuses a verified PostgreSQL companion base before creating capture output", async () => {
    const prepared = await prepareBackupArchive(baseArchive);
    const extracted = state.path("companion-base");
    await fs.mkdir(extracted);
    await tar.x({ file: baseArchive, cwd: extracted });
    const manifestPath = path.join(extracted, prepared.result.archiveRoot, "manifest.json");
    const manifest: BackupManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const sourcePath = state.statePath("state/openclaw.sqlite");
    const anchor = path.join(extracted, buildBackupArchivePath(manifest.archiveRoot, sourcePath));
    await fs.unlink(anchor);
    {
      using database = new DatabaseSync(anchor);
      database.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
      );
      database.exec(
        "INSERT INTO openclaw_engine_anchor VALUES ('companion-store', 'postgres', 'companion_namespace')",
      );
    }
    manifest.profile = "local-companion";
    manifest.postgresSnapshots = [];
    manifest.postgresAnchors = [
      { sourcePath, storeId: "companion-store", namespace: "companion_namespace" },
    ];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const archive = state.path("companion-base.tar.gz");
    await tar.c({ file: archive, gzip: true, cwd: extracted }, [manifest.archiveRoot]);
    const companion = await prepareBackupArchive(archive);
    expect(companion.databaseRestoreCandidates).toHaveLength(0);
    expect(companion.manifest.postgresAnchors).toHaveLength(1);
    const output = state.path("refused-companion-capture");
    await expect(createDatabaseMigrationCapture({ baseArchive: archive, output })).rejects.toThrow(
      "requires a SQLite-only base archive",
    );
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an output directory aliased into live state before creating artifacts", async () => {
    await expect(
      createDatabaseMigrationCapture({
        baseArchive,
        output: path.join(selectedStateDir, "nested-capsule"),
      }),
    ).rejects.toThrow("outside the source state and configuration roots");
    await expect(fs.stat(state.statePath("nested-capsule"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a shared database without a local credential image", async () => {
    const local = state.statePath("client/credentials.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await fs.rm(`${local}${suffix}`, { force: true });
    }
    const base = await createBackupArchive({
      output: state.path("no-local-base.tar.gz"),
      verify: true,
    });
    const capture = await createDatabaseMigrationCapture({
      baseArchive: base.archivePath,
      output: state.path("no-local-capsule"),
    });
    const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
    expect(manifest.sourceSharedFile).not.toBeNull();
    expect(manifest.missingDatabases).toContain(local);
    const restored = await restoreDatabaseMigrationCapture(createTestRuntime(), {
      capture: capture.directory,
      target: state.path("no-local-staging"),
      manifestSha256: capture.manifestSha256,
    });
    const staged = (file: string) =>
      path.join(restored.targetPath, buildBackupArchivePath(restored.archiveRoot, file));
    await expect(fs.stat(staged(local))).rejects.toMatchObject({ code: "ENOENT" });
    using database = new DatabaseSync(staged(state.statePath("state/openclaw.sqlite")), {
      readOnly: true,
    });
    expect(database.prepare("SELECT value FROM migration_witness").all()).toEqual([
      { value: "exact retained history" },
    ]);
  });

  it("refuses changed capsule contents and producer metadata before creating a restore target", async () => {
    const copied = state.path("tampered-capsule");
    await fs.cp(capsule.directory, copied, { recursive: true });
    const manifestPath = path.join(copied, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    await fs.appendFile(path.join(copied, manifest.configs[0].file), "changed");
    const target = state.path("refused-staging");
    const restore = () =>
      restoreDatabaseMigrationCapture(createTestRuntime(), {
        capture: copied,
        target,
        manifestSha256: capsule.manifestSha256,
      });
    await expect(restore()).rejects.toThrow("artifact changed");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.appendFile(manifestPath, " ");
    await expect(restore()).rejects.toThrow("differs from its producer receipt");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
