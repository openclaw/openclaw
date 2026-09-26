import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { buildBackupArchivePath } from "./backup-shared.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { backupVerifyCommand, verifyBackupArchive } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  options: { onlyConfig?: boolean; legacy?: boolean } = {},
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
    options: { onlyConfig: options.onlyConfig ?? false },
    paths: { stateDir },
    assets: [
      { kind: options.onlyConfig ? "config" : "state", sourcePath: stateDir, archivePath: payload },
    ],
    ...(options.legacy ? {} : { sqliteSnapshots }),
  };
  await fs.writeFile(path.join(root, archiveRoot, "manifest.json"), JSON.stringify(manifest));
  return {
    root,
    archiveRoot,
    stateDir,
    payload,
    archivePath: await repack(root, archiveRoot, "fixture"),
  };
}

describe("standalone backup database completeness", () => {
  it("restores configured, registered, and discovered WAL databases without workspaces and rejects each omission", async () => {
    await withOpenClawTestState(
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
              main: { default: true, workspace: dormantWorkspace },
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
          const manifest: BackupManifest = JSON.parse(
            await fs.readFile(path.join(extracted, archive.archiveRoot, "manifest.json"), "utf8"),
          );
          expect(manifest.sqliteSnapshots).toEqual([
            { sourcePath: databasePaths[0], role: "global" },
            { sourcePath: databasePaths[1], role: "agent", agentId: "main" },
            { sourcePath: databasePaths[2], role: "agent", agentId: "worker" },
            { sourcePath: databasePaths[3], role: "agent", agentId: "external" },
            { sourcePath: databasePaths[4], role: "agent", agentId: "dormant" },
            { sourcePath: databasePaths[5], role: "agent", agentId: "external" },
            { sourcePath: databasePaths[6], role: "agent", agentId: "linked" },
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
            const db = new DatabaseSync(snapshot, { readOnly: true });
            try {
              expect(db.prepare("SELECT value FROM completeness_witness").all()).toEqual([
                { value: `committed-${index}` },
              ]);
            } finally {
              db.close();
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
              `Backup lacks verified canonical SQLite coverage for ${databasePaths[index < databasePaths.length ? index : 0]}.`,
            );
          }
          for (const [index, writer] of writers.entries()) {
            expect(writer.prepare("SELECT value FROM completeness_witness").all()).toEqual([
              { value: `committed-${index}` },
            ]);
          }
        } finally {
          for (const writer of writers) {
            writer.close();
          }
        }
      },
    );
  });

  it.each([false, true])(
    "captures an empty inventory honestly (onlyConfig=%s)",
    async (onlyConfig) => {
      await withOpenClawTestState(
        { layout: "home", prefix: "backup-empty-inventory-", scenario: "minimal" },
        async (state) => {
          if (onlyConfig) {
            openOpenClawAgentDatabase({
              agentId: "main",
              path: path.join(state.agentDir(), "openclaw-agent.sqlite"),
              env: state.env,
            });
          }
          const archive = await backupCreateCommand(createTestRuntime(), {
            output: state.path("backup.tar.gz"),
            onlyConfig,
            includeWorkspace: false,
          });
          const extracted = state.path("extracted");
          await fs.mkdir(extracted);
          await tar.x({ file: archive.archivePath, cwd: extracted });
          const manifest = JSON.parse(
            await fs.readFile(path.join(extracted, archive.archiveRoot, "manifest.json"), "utf8"),
          );
          expect(manifest.sqliteSnapshots).toEqual([]);
          await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
            ok: true,
            sqliteInventoryVerified: true,
          });
        },
      );
    },
  );

  it("does not require a registered database that was absent at capture time", async () => {
    await withOpenClawTestState(
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

  it("reports unknown completeness for legacy archives instead of inventing an inventory", async () => {
    const { archivePath } = await writeSmallArchive(undefined, { legacy: true });
    const runtime = createTestRuntime();
    await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject({
      ok: true,
      sqliteInventoryVerified: false,
    });
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("completeness unknown"));
    await expect(
      verifyBackupArchive(archivePath, [
        { role: "global", sourcePath: "/synthetic/state/state/openclaw.sqlite", dev: 1, ino: 1 },
      ]),
    ).rejects.toThrow("lacks verified canonical SQLite coverage");
  });

  it("does not claim completeness for legacy registered agents absent from the archive", async () => {
    const fixture = await writeSmallArchive(undefined, { legacy: true });
    const globalPath = path.join(fixture.root, fixture.payload, "state/openclaw.sqlite");
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    const db = new DatabaseSync(globalPath);
    try {
      db.exec(
        "CREATE TABLE schema_meta(meta_key TEXT, role TEXT); INSERT INTO schema_meta VALUES ('primary','global'); CREATE TABLE agent_databases(agent_id TEXT,path TEXT); INSERT INTO agent_databases VALUES ('main','agents/main/agent/openclaw-agent.sqlite');",
      );
    } finally {
      db.close();
    }
    const archivePath = await repack(fixture.root, fixture.archiveRoot, "missing-agent");
    await expect(verifyBackupArchive(archivePath)).resolves.toMatchObject({
      ok: true,
      sqliteInventoryVerified: false,
    });
  });

  it.each([
    { name: "non-array", value: {}, error: "must be an array" },
    {
      name: "unknown role",
      value: [{ role: "plugin", sourcePath: "/db" }],
      error: "invalid SQLite snapshot owner",
    },
    {
      name: "relative path",
      value: [{ role: "global", sourcePath: "../db" }],
      error: "absolute and normalized",
    },
    {
      name: "noncanonical agent",
      value: [{ role: "agent", sourcePath: "/db", agentId: "Main" }],
      error: "invalid agentId",
    },
    {
      name: "duplicate owner",
      value: [
        { role: "global", sourcePath: "/db" },
        { role: "global", sourcePath: "/other" },
      ],
      error: "duplicate SQLite snapshot ownership",
    },
    {
      name: "duplicate path",
      value: [
        { role: "global", sourcePath: "/db" },
        { role: "agent", sourcePath: "/DB", agentId: "main" },
      ],
      error: "duplicate SQLite snapshot ownership",
    },
    {
      name: "host identity field",
      value: [{ role: "global", sourcePath: "/db", ino: 1 }],
      error: "invalid SQLite snapshot owner",
    },
  ])("rejects $name inventory metadata", async ({ value, error }) => {
    const { archivePath } = await writeSmallArchive(value);
    await expect(verifyBackupArchive(archivePath)).rejects.toThrow(error);
  });
});
