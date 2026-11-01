import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import { withIsolatedBackupState } from "../infra/backup-create.test-support.js";
import type { PostgresExportEnvelope } from "../snapshot/export-envelope.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { backupRestoreCommand } from "./backup-restore.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { backupVerifyCommand, verifyBackupArchive } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return { ...actual, t: vi.fn(actual.t), x: vi.fn(actual.x) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readManifest = async (root: string, archiveRoot: string): Promise<BackupManifest> =>
  JSON.parse(await fs.readFile(path.join(root, archiveRoot, "manifest.json"), "utf8"));
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const postgresCapture = (
  archivePath = "backup/payload/plugin.sqlite.postgres",
  manifestSha256 = "0".repeat(64),
) => ({ archivePath, manifestSha256 });

function expectWitness(db: DatabaseSync, index: number) {
  expect(db.prepare("SELECT value FROM completeness_witness").all()).toEqual([
    { value: `committed-${index}` },
  ]);
}

async function repack(root: string, archiveRoot: string, name: string, omit: string[] = []) {
  const archivePath = path.join(root, name + ".tar.gz");
  await tar.c(
    {
      file: archivePath,
      gzip: true,
      cwd: root,
      filter: (entry) => !omit.includes(entry.replaceAll("\\", "/")),
    },
    [archiveRoot],
  );
  return archivePath;
}

async function writeSmallArchive(
  sqliteSnapshots: unknown,
  postgresSnapshots?: unknown,
  sharedDatabaseSourcePath?: unknown,
) {
  const root = tempDirs.make("backup-inventory-contract-");
  const archiveRoot = "backup";
  const stateDir = "/synthetic/state";
  const payload = buildBackupArchivePath(archiveRoot, stateDir);
  await fs.mkdir(path.join(root, payload), { recursive: true });
  await fs.writeFile(path.join(root, payload, "config.json"), "{}\n");
  const manifest = {
    schemaVersion: 1,
    archiveRoot,
    createdAt: "2026-03-09T00:00:00Z",
    platform: process.platform,
    runtimeVersion: "test",
    nodeVersion: process.version,
    paths: {
      stateDir,
      ...(sharedDatabaseSourcePath === undefined ? {} : { sharedDatabaseSourcePath }),
    },
    assets: [{ kind: "state", sourcePath: stateDir, archivePath: payload }],
    sqliteSnapshots,
    ...(postgresSnapshots === undefined ? {} : { postgresSnapshots }),
  };
  await writeJson(path.join(root, archiveRoot, "manifest.json"), manifest);
  return {
    root,
    archiveRoot,
    payload,
    archivePath: await repack(root, archiveRoot, "fixture"),
  };
}

describe("standalone backup database completeness", () => {
  it("distinguishes ordinary backups from SQLite-only companions before extraction", async () => {
    const fixture = await writeSmallArchive([], []);
    const target = path.join(fixture.root, "refused");
    await expect(
      backupRestoreCommand(createTestRuntime(), {
        archive: fixture.archivePath,
        target,
        localCompanion: true,
      }),
    ).rejects.toThrow("requires a local-companion checkpoint");
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const manifest = await readManifest(fixture.root, fixture.archiveRoot);
    manifest.profile = "local-companion";
    manifest.postgresAnchors = [];
    await writeJson(path.join(fixture.root, fixture.archiveRoot, "manifest.json"), manifest);
    const archive = await repack(fixture.root, fixture.archiveRoot, "sqlite-companion");
    await expect(
      backupRestoreCommand(createTestRuntime(), {
        archive,
        target,
        sourceEngine: "sqlite",
        localCompanion: true,
      }),
    ).resolves.toMatchObject({ ok: true, profile: "local-companion" });
  });

  it.each([
    "valid",
    "identity",
    "namespace",
    "sidecar",
    "undeclared",
    "export",
    "unlisted export",
    "unknown profile",
    "duplicate anchor",
    "missing inventory",
  ])("verifies offline local-companion anchors and preserves namespaces (%s)", async (damage) => {
    const sourcePath = "/synthetic/state/state/openclaw.sqlite";
    const fixture = await writeSmallArchive([{ sourcePath, role: "global" }], []);
    const archivePath = buildBackupArchivePath(fixture.archiveRoot, sourcePath);
    const anchorPath = path.join(fixture.root, archivePath);
    await fs.mkdir(path.dirname(anchorPath), { recursive: true });
    {
      using database = new DatabaseSync(anchorPath);
      database.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)",
      );
      database.exec(
        "INSERT INTO openclaw_engine_anchor VALUES ('original-store', 'postgres', 'original_namespace')",
      );
    }
    const manifestPath = path.join(fixture.root, fixture.archiveRoot, "manifest.json");
    const manifest: BackupManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.profile = "local-companion";
    manifest.postgresAnchors =
      damage === "undeclared"
        ? []
        : [
            {
              sourcePath,
              storeId: damage === "identity" ? "other-store" : "original-store",
              namespace: damage === "namespace" ? "other_namespace" : "original_namespace",
            },
          ];
    if (damage === "sidecar") {
      await fs.writeFile(`${anchorPath}-wal`, "uncheckpointed");
    }
    if (damage === "export") {
      manifest.postgresSnapshots = [
        { archivePath: `${archivePath}.postgres`, manifestSha256: "a".repeat(64) },
      ];
    }
    if (damage === "unknown profile") {
      Object.assign(manifest, { profile: "unsupported" });
    } else if (damage === "duplicate anchor") {
      manifest.postgresAnchors!.push({ ...manifest.postgresAnchors![0]! });
    } else if (damage === "missing inventory") {
      delete manifest.postgresAnchors;
    }
    if (damage === "unlisted export") {
      await fs.mkdir(`${anchorPath}.postgres`);
      await fs.writeFile(path.join(`${anchorPath}.postgres`, "database.sqlite"), "undeclared rows");
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const archive = await repack(fixture.root, fixture.archiveRoot, "companion");
    if (damage !== "valid") {
      await expect(verifyBackupArchive(archive)).rejects.toThrow(
        damage === "identity" || damage === "namespace"
          ? /identity mismatch/
          : damage === "sidecar"
            ? /sidecars/
            : damage === "undeclared"
              ? /no owned matched capsule/
              : damage === "unlisted export"
                ? /undeclared PostgreSQL export/
                : damage === "unknown profile"
                  ? /unsupported profile/
                  : damage === "duplicate anchor"
                    ? /duplicate PostgreSQL anchor/
                    : damage === "missing inventory"
                      ? /requires PostgreSQL anchor inventory/
                      : /no PostgreSQL exports/,
      );
      return;
    }
    const verified = await verifyBackupArchive(archive);
    expect(verified).toMatchObject({
      ok: true,
      profile: "local-companion",
      sqliteInventoryVerified: true,
    });
    expect(verified.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("not disaster recovery")]),
    );
    const refused = path.join(fixture.root, "sqlite-only");
    await expect(
      backupRestoreCommand(createTestRuntime(), {
        archive,
        target: refused,
        sourceEngine: "sqlite",
      }),
    ).rejects.toThrow("requires a SQLite-only archive");
    await expect(fs.stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
    const target = path.join(fixture.root, "restored");
    await backupRestoreCommand(createTestRuntime(), { archive, target, localCompanion: true });
    using restored = new DatabaseSync(path.join(target, archivePath), { readOnly: true });
    expect(
      restored.prepare("SELECT store_id, schema FROM openclaw_engine_anchor").get(),
    ).toMatchObject({
      store_id: "original-store",
      schema: "original_namespace",
    });
    await expect(fs.stat(path.join(target, `${archivePath}.postgres`))).rejects.toThrow();
  });

  it("restores configured, registered, and discovered WAL databases without workspaces and rejects each omission", async () => {
    await withIsolatedBackupState(
      { layout: "home", prefix: "backup-inventory-wal-", scenario: "minimal" },
      async (state) => {
        const externalAgent = state.path("external-agent");
        const linkedAgent = state.path("linked-agent");
        const agentLink = state.statePath("agents", "linked");
        const dormantWorkspace = state.statePath("agents", "dormant");
        await state.writeConfig({
          agents: {
            defaults: { workspace: state.home },
            entries: {
              main: { workspace: dormantWorkspace },
              external: { agentDir: externalAgent },
            },
          },
        });
        const agents = [
          { agentId: "main", directory: state.agentDir(), registered: true },
          { agentId: "worker", directory: state.agentDir("worker"), registered: true },
          { agentId: "external", directory: externalAgent, registered: false },
          { agentId: "dormant", directory: state.agentDir("dormant"), registered: false },
          { agentId: "external", directory: state.agentDir("external"), registered: false },
          { agentId: "linked", directory: path.join(linkedAgent, "agent"), registered: false },
        ];
        const agentPaths = agents.map(({ agentId, directory, registered }) => {
          const databasePath = path.join(directory, "openclaw-agent.sqlite");
          openOpenClawAgentDatabase({ agentId, path: databasePath, env: state.env });
          if (!registered) {
            unregisterOpenClawAgentDatabase({ agentId, path: databasePath, env: state.env });
          }
          return databasePath;
        });
        await fs.symlink(linkedAgent, agentLink, process.platform === "win32" ? "junction" : "dir");
        const databasePaths = [resolveOpenClawStateSqlitePath(state.env), ...agentPaths];
        const writers: DatabaseSync[] = [];
        try {
          for (const [index, databasePath] of databasePaths.entries()) {
            const db = new DatabaseSync(databasePath);
            writers.push(db);
            db.exec(
              "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE completeness_witness (value TEXT); PRAGMA wal_checkpoint(TRUNCATE);",
            );
            db.prepare("INSERT INTO completeness_witness VALUES (?)").run(`committed-${index}`);
            expect((await fs.stat(databasePath + "-wal")).size).toBeGreaterThan(32);
          }
          const workspaceFiles = [state.home, dormantWorkspace].map((directory) =>
            path.join(directory, "workspace-only.txt"),
          );
          for (const file of workspaceFiles) {
            await fs.writeFile(file, "exclude me");
          }
          const runtime = createTestRuntime();
          const archive = await backupCreateCommand(runtime, {
            output: state.path("full.tar.gz"),
            includeWorkspace: false,
            verify: true,
          });
          expect(archive.verified).toBe(true);
          await expect(
            backupVerifyCommand(runtime, { archive: archive.archivePath, json: true }),
          ).resolves.toMatchObject({ ok: true, sqliteInventoryVerified: true });
          const extracted = state.path("extracted");
          await backupRestoreCommand(runtime, { archive: archive.archivePath, target: extracted });
          const manifest = await readManifest(extracted, archive.archiveRoot);
          expect(manifest.sqliteSnapshots).toEqual([
            { sourcePath: databasePaths[0], role: "global" },
            ...agents.map(({ agentId }, index) => ({
              sourcePath: databasePaths[index + 1],
              role: "agent",
              agentId,
            })),
          ]);
          const restoredLink = path.join(
            extracted,
            buildBackupArchivePath(archive.archiveRoot, agentLink),
          );
          expect((await fs.lstat(restoredLink)).isSymbolicLink()).toBe(true);
          for (const file of workspaceFiles) {
            await expect(
              fs.stat(path.join(extracted, buildBackupArchivePath(archive.archiveRoot, file))),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          const members = databasePaths.map((p) => buildBackupArchivePath(archive.archiveRoot, p));
          for (const [index, member] of members.entries()) {
            const snapshot = path.join(extracted, member);
            {
              using db = new DatabaseSync(snapshot, { readOnly: true });
              expectWitness(db, index);
            }
            for (const suffix of ["-wal", "-shm", "-journal"]) {
              await expect(fs.stat(snapshot + suffix)).rejects.toMatchObject({ code: "ENOENT" });
            }
          }
          for (const [index, missing] of [
            ...members.map((member) => [member]),
            members,
          ].entries()) {
            const incomplete = await repack(
              extracted,
              archive.archiveRoot,
              `missing-${index}`,
              missing,
            );
            await expect(
              backupVerifyCommand(createTestRuntime(), { archive: incomplete }),
            ).rejects.toThrow(
              `Backup lacks verified SQLite database coverage for ${databasePaths[index < databasePaths.length ? index : 0]}.`,
            );
          }
          for (const [index, writer] of writers.entries()) {
            expectWitness(writer, index);
          }
        } finally {
          for (const writer of writers) {
            writer.close();
          }
        }
      },
    );
  });

  it("captures an empty inventory for a config-only backup", async () => {
    await withIsolatedBackupState(
      { layout: "home", prefix: "backup-empty-inventory-", scenario: "minimal" },
      async (state) => {
        openOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          env: state.env,
        });
        const archive = await backupCreateCommand(createTestRuntime(), {
          output: state.path("backup.tar.gz"),
          onlyConfig: true,
          includeWorkspace: false,
        });
        const extracted = state.path("extracted");
        await fs.mkdir(extracted);
        await tar.x({ file: archive.archivePath, cwd: extracted });
        expect(await readManifest(extracted, archive.archiveRoot)).toMatchObject({
          sqliteSnapshots: [],
          postgresSnapshots: [],
        });
        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
          ok: true,
          sqliteInventoryVerified: true,
        });
      },
    );
  });

  it("does not require a registered database that was absent at capture time", async () => {
    await withIsolatedBackupState(
      { layout: "home", prefix: "backup-absent-registration-", scenario: "minimal" },
      async (state) => {
        registerOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          env: state.env,
        });
        const archive = await backupCreateCommand(createTestRuntime(), {
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
          verify: true,
        });
        expect(archive.verified).toBe(true);
        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
          ok: true,
          sqliteInventoryVerified: true,
        });
      },
    );
  });

  it.each([
    ["non-array", {}, "must be an array"],
    [
      "noncanonical agent",
      [{ role: "agent", sourcePath: "/db", agentId: "Main" }],
      "invalid agentId",
    ],
    [
      "duplicate path",
      [
        { role: "global", sourcePath: "/db" },
        { role: "agent", sourcePath: "/DB", agentId: "main" },
      ],
      "duplicate SQLite snapshot ownership",
    ],
    [
      "host identity field",
      [{ role: "global", sourcePath: "/db", ino: 1 }],
      "invalid SQLite snapshot owner",
    ],
  ] as const)("rejects %s inventory metadata", async (_name, value, error) => {
    const { archivePath } = await writeSmallArchive(value);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(error);
  });

  it.each([null, 7, "relative.sqlite", "/shared/../state.sqlite", "/shared\0.sqlite"])(
    "rejects malformed captured shared source identity %j",
    async (sourcePath) => {
      const { archivePath } = await writeSmallArchive([], undefined, sourcePath);
      await expect(verifyBackupArchive(archivePath)).rejects.toThrow("shared database source");
    },
  );

  it("does not require the captured shared source path to exist on the restore host", async () => {
    const { archivePath } = await writeSmallArchive(
      [],
      undefined,
      "/missing/captured/shared.sqlite",
    );
    await expect(verifyBackupArchive(archivePath)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["non-array", {}, "postgresSnapshots must be an array"],
    ["relative path", [postgresCapture("plugin.sqlite.postgres")], "outside payload root"],
    [
      "duplicate path",
      [postgresCapture(), postgresCapture("backup/payload/PLUGIN.sqlite.postgres")],
      "duplicate PostgreSQL snapshot paths",
    ],
    ["invalid hash", [postgresCapture(undefined, "unknown")], "invalid PostgreSQL snapshot"],
    ["missing capsule", [postgresCapture()], "missing a regular matched artifact"],
  ] as const)("rejects %s PostgreSQL inventory", async (_name, value, error) => {
    const { archivePath } = await writeSmallArchive([], value);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(error);
  });
});

describe("archive PostgreSQL capsule verification", () => {
  it.each([
    "truncated archive",
    "SQLite snapshot",
    "manifest mismatch",
    "image",
    "manifest",
    "inner anchor",
    "outer anchor",
    "pending capture",
    "manifest binding",
    "unowned anchor",
    "database WAL",
    "inner anchor WAL",
    "outer anchor WAL",
  ])(
    "rejects incomplete or damaged plugin-only PostgreSQL archives (%s) before restore",
    async (damage) => {
      const sourcePath = "/synthetic/plugins/workboard.sqlite";
      const fixture = await writeSmallArchive([], []);
      const anchorPath = buildBackupArchivePath(fixture.archiveRoot, sourcePath);
      const directoryPath = `${anchorPath}.postgres`;
      const directory = path.join(fixture.root, directoryPath);
      await fs.mkdir(directory, { recursive: true });
      const anchor = path.join(fixture.root, anchorPath);
      const storeId = "64c70dfe-1d42-4ae2-b7f1-197ff7eb3339";
      {
        using db = new DatabaseSync(anchor);
        db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
        db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', 'original')").run(
          storeId,
        );
      }
      await fs.copyFile(anchor, path.join(directory, "anchor.sqlite"));
      {
        using db = new DatabaseSync(path.join(directory, "database.sqlite"));
        db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('retained')");
      }
      using walWriter = damage.endsWith(" WAL")
        ? new DatabaseSync(
            damage === "outer anchor WAL"
              ? anchor
              : path.join(
                  directory,
                  damage === "database WAL" ? "database.sqlite" : "anchor.sqlite",
                ),
          )
        : undefined;
      walWriter?.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)",
      );
      const artifact = async (name: string) => {
        const bytes = await fs.readFile(path.join(directory, name));
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        };
      };
      const envelope: PostgresExportEnvelope = {
        schemaVersion: 2,
        snapshotId: path.basename(directory),
        createdAt: "2026-10-16T00:00:00.000Z",
        profile: "user-backup",
        source: {
          engine: "postgres",
          storeId,
          namespace: "original",
          owner: "workboard",
          schemaVersion: 1,
        },
        exportSchemaVersion: 1,
        activeFragments: [],
        verification: { tables: {}, allocations: {} },
        sanitizedDifferences: [],
        artifacts: {
          "database.sqlite": await artifact("database.sqlite"),
          "anchor.sqlite": await artifact("anchor.sqlite"),
        },
      };
      const manifestPath = path.join(directory, "manifest.json");
      await writeJson(manifestPath, envelope);
      const archiveManifestPath = path.join(fixture.root, fixture.archiveRoot, "manifest.json");
      const manifest = await readManifest(fixture.root, fixture.archiveRoot);
      const globalPath = `${fixture.payload}/state/openclaw.sqlite`;
      await fs.mkdir(path.dirname(path.join(fixture.root, globalPath)), { recursive: true });
      {
        using db = new DatabaseSync(path.join(fixture.root, globalPath));
        db.exec(`CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT);
          INSERT INTO schema_meta VALUES ('primary', 'global');
          CREATE TABLE agent_databases (agent_id TEXT, path TEXT)`);
      }
      manifest.sqliteSnapshots = [
        { role: "global", sourcePath: "/synthetic/state/state/openclaw.sqlite" },
      ];
      const captureHash = async () =>
        createHash("sha256")
          .update(await fs.readFile(manifestPath))
          .digest("hex");
      manifest.postgresSnapshots = [
        { archivePath: directoryPath, manifestSha256: await captureHash() },
      ];
      manifest.assets.push({
        kind: "plugin",
        sourcePath: "/synthetic",
        archivePath: buildBackupArchivePath(fixture.archiveRoot, "/synthetic"),
      });
      await writeJson(archiveManifestPath, manifest);
      const readsBefore = vi.mocked(tar.t).mock.calls.length;
      const extractsBefore = vi.mocked(tar.x).mock.calls.length;
      await expect(
        verifyBackupArchive(
          await repack(
            fixture.root,
            fixture.archiveRoot,
            "valid",
            // The checkpointed control image is sealed without the open writer's sidecars.
            [
              anchorPath,
              `${directoryPath}/anchor.sqlite`,
              `${directoryPath}/database.sqlite`,
            ].flatMap((file) => [file + "-wal", file + "-shm"]),
          ),
        ),
      ).resolves.toMatchObject({ ok: true });
      expect(tar.t).toHaveBeenCalledTimes(readsBefore + 1);
      expect(tar.x).toHaveBeenCalledTimes(extractsBefore);
      if (damage === "SQLite snapshot") {
        const dbPath = path.join(fixture.root, globalPath);
        const bytes = await fs.readFile(dbPath);
        bytes[100] = 0;
        await fs.writeFile(dbPath, bytes);
      } else if (damage === "manifest mismatch") {
        manifest.assets[0]!.archivePath += "/missing";
        await writeJson(archiveManifestPath, manifest);
      } else if (damage === "truncated archive") {
        // Truncate the compressed stream after a complete, otherwise valid capture.
      } else if (walWriter) {
        walWriter.exec(
          damage === "database WAL"
            ? "UPDATE notes SET body = 'unmanifested'"
            : "UPDATE openclaw_engine_anchor SET schema = 'unmanifested'",
        );
      } else if (damage === "manifest binding") {
        manifest.postgresSnapshots[0]!.manifestSha256 = "0".repeat(64);
        await writeJson(archiveManifestPath, manifest);
      } else if (damage === "unowned anchor") {
        manifest.postgresSnapshots = [];
        manifest.sqliteSnapshots = [{ sourcePath, role: "agent", agentId: "main" }];
        manifest.paths = { stateDir: "/synthetic" };
        manifest.assets[0]!.kind = "state";
        await writeJson(archiveManifestPath, manifest);
      } else if (damage === "pending capture") {
        await fs.writeFile(path.join(directory, ".pending"), "");
      } else if (damage === "image") {
        await fs.appendFile(path.join(directory, "database.sqlite"), "corrupt");
      } else if (damage === "manifest") {
        await fs.writeFile(manifestPath, '{"source":{"engine":"postgres"}}');
      } else {
        const file = damage === "inner anchor" ? path.join(directory, "anchor.sqlite") : anchor;
        {
          using db = new DatabaseSync(file);
          db.exec("UPDATE openclaw_engine_anchor SET schema = 'different'");
        }
        if (damage === "inner anchor") {
          envelope.artifacts["anchor.sqlite"] = await artifact("anchor.sqlite");
          await writeJson(manifestPath, envelope);
          manifest.postgresSnapshots[0]!.manifestSha256 = await captureHash();
          await writeJson(archiveManifestPath, manifest);
        }
      }
      const damaged = await repack(fixture.root, fixture.archiveRoot, "damaged");
      if (damage === "truncated archive") {
        const bytes = await fs.readFile(damaged);
        await fs.writeFile(damaged, bytes.subarray(0, -16));
      }
      const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
      const open = fs.open;
      using _ = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        handles.push(handle);
        return handle;
      });
      await expect(verifyBackupArchive(damaged)).rejects.toThrow(
        damage === "manifest mismatch"
          ? /missing payload/
          : damage === "manifest binding"
            ? /does not match its capture inventory/
            : walWriter
              ? /unexpected SQLite sidecar/
              : /verification failed/,
      );
      expect(handles.filter((handle) => handle.fd !== -1)).toEqual([]);
      expect(tar.t).toHaveBeenCalledTimes(readsBefore + 2);
      expect(tar.x).toHaveBeenCalledTimes(extractsBefore);
    },
  );
});
