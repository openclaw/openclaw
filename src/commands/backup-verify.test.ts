// Backup verify tests cover archive inspection, gzip validation, and corrupted backup diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import * as diskSpace from "../infra/disk-space.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { buildBackupArchivePath } from "./backup-shared.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { backupVerifyCommand, verifyBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return { ...actual, t: vi.fn(actual.t), x: vi.fn(actual.x) };
});

const actualTar = await vi.importActual<typeof import("tar")>("tar");

const TEST_ARCHIVE_ROOT = "2026-03-09T00-00-00.000Z-openclaw-backup";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createBackupManifest(
  assetArchivePath: string,
  archiveRoot = TEST_ARCHIVE_ROOT,
  stateDir = "/tmp/.openclaw",
): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: "2026-03-09T00:00:00.000Z",
    archiveRoot,
    runtimeVersion: "test",
    platform: process.platform,
    nodeVersion: process.version,
    paths: {
      stateDir,
    },
    assets: [
      {
        kind: "state",
        sourcePath: stateDir,
        archivePath: assetArchivePath,
      },
    ],
  };
}

function encodeTarEntry(params: {
  path: string;
  contents?: string;
  type?: "File" | "Link" | "SymbolicLink";
  linkpath?: string;
}): Buffer {
  const body = Buffer.from(params.contents ?? "", "utf8");
  const type = params.type ?? "File";
  const header = new tar.Header({
    path: params.path,
    type,
    size: type === "File" ? body.length : 0,
    mode: 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (type !== "File") {
    return headerBlock;
  }
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([headerBlock, body, padding]);
}

function isTarSourcePath(entryPath: string, sourcePath: string): boolean {
  return path.resolve(entryPath) === path.resolve(sourcePath);
}

async function createArchiveWithManifestContent(
  options: {
    tempPrefix: string;
    manifestContent: string;
    payloadArchivePath?: string;
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadPath = path.join(tempDir, "payload.txt");
  const payloadArchivePath =
    options.payloadArchivePath ?? `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
  try {
    await fs.writeFile(manifestPath, options.manifestContent, "utf8");
    await fs.writeFile(payloadPath, "payload\n", "utf8");
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (isTarSourcePath(entry.path, manifestPath)) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          if (isTarSourcePath(entry.path, payloadPath)) {
            entry.path = payloadArchivePath;
          }
        },
      },
      [manifestPath, payloadPath],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withBrokenArchiveFixture(
  options: {
    tempPrefix: string;
    manifestAssetArchivePath: string;
    manifest?: ReturnType<typeof createBackupManifest>;
    payloads: Array<{ fileName: string; contents: string | Uint8Array; archivePath?: string }>;
    buildTarEntries?: (paths: { manifestPath: string; payloadPaths: string[] }) => string[];
  },
  run: (archivePath: string) => Promise<void>,
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), options.tempPrefix));
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const manifestPath = path.join(tempDir, "manifest.json");
  const payloadSpecs = await Promise.all(
    options.payloads.map(async (payload) => {
      const payloadPath = path.join(tempDir, payload.fileName);
      await fs.writeFile(payloadPath, payload.contents, "utf8");
      return {
        path: payloadPath,
        archivePath: payload.archivePath ?? options.manifestAssetArchivePath,
      };
    }),
  );
  const payloadEntryPathBySource = new Map(
    payloadSpecs.map((payload) => [path.resolve(payload.path), payload.archivePath]),
  );

  try {
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(options.manifest ?? createBackupManifest(options.manifestAssetArchivePath), null, 2)}\n`,
      "utf8",
    );
    await tar.c(
      {
        file: archivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        onWriteEntry: (entry) => {
          if (isTarSourcePath(entry.path, manifestPath)) {
            entry.path = `${TEST_ARCHIVE_ROOT}/manifest.json`;
            return;
          }
          const payloadEntryPath = payloadEntryPathBySource.get(path.resolve(entry.path));
          if (payloadEntryPath) {
            entry.path = payloadEntryPath;
          }
        },
      },
      options.buildTarEntries?.({
        manifestPath,
        payloadPaths: payloadSpecs.map((payload) => payload.path),
      }) ?? [manifestPath, ...payloadSpecs.map((payload) => payload.path)],
    );
    await run(archivePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createSqlitePayload(setup: (database: DatabaseSync) => void): Promise<Buffer> {
  const tempDir = tempDirs.make("openclaw-backup-verify-sqlite-db-");
  const databasePath = path.join(tempDir, "snapshot.sqlite");
  try {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      setup(database);
    } finally {
      database.close();
    }
    return await fs.readFile(databasePath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function createRegisteredAgentPayload(
  agentId: string | undefined,
  databasePath = "",
  stateDir = "/tmp/.openclaw",
) {
  return {
    fileName: "registry.sqlite",
    archivePath: `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir)}/state/openclaw.sqlite`,
    contents: await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO schema_meta VALUES ('primary', 'global');
        CREATE TABLE agent_databases (agent_id TEXT NOT NULL, path TEXT NOT NULL);
      `);
      if (agentId !== undefined) {
        database
          .prepare("INSERT INTO agent_databases (agent_id, path) VALUES (?, ?)")
          .run(agentId, databasePath);
      }
    }),
  };
}

describe("backupVerifyCommand", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(tar.t).mockReset().mockImplementation(actualTar.t);
    vi.mocked(tar.x).mockReset().mockImplementation(actualTar.x);
  });

  it.each([
    {
      name: "missing archive",
      prepare: async (tempDir: string) => path.join(tempDir, "missing.tar.gz"),
      detail:
        "Archive does not exist. Check the path and run `openclaw backup verify <archive>` again.",
    },
    {
      name: "directory",
      prepare: async (tempDir: string) => tempDir,
      detail:
        "Archive must be a regular file. Choose a backup archive created by `openclaw backup create` and try again.",
    },
  ])("reports an actionable failure for $name", async ({ prepare, detail }) => {
    const tempDir = tempDirs.make("openclaw-backup-verify-input-");
    const archivePath = await prepare(tempDir);
    const runtime = createTestRuntime();

    await runCommandWithRuntime(runtime, async () => {
      await backupVerifyCommand(runtime, { archive: archivePath });
    });

    expect(runtime.error).toHaveBeenCalledWith(
      `Backup archive verification failed: ${archivePath}. ${detail}`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([{ name: "missing path", type: "File" as const, detail: "path is required" }])(
    "rejects a $name header after valid backup entries",
    async ({ name, type, detail }) => {
      const tempDir = tempDirs.make("openclaw-backup-verify-invalid-header-");
      const archivePath = path.join(tempDir, "invalid.tar.gz");
      const payloadPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/note.txt`;
      const invalidEntry = encodeTarEntry({
        path: name === "missing path" ? "" : `${TEST_ARCHIVE_ROOT}/payload/invalid`,
        type,
        ...(name === "forbidden link target" ? { linkpath: "note.txt" } : {}),
      });
      if (name === "bad checksum") {
        invalidEntry.writeUInt8(invalidEntry.readUInt8(0) ^ 1, 0);
      }
      await fs.writeFile(
        archivePath,
        gzipSync(
          Buffer.concat([
            encodeTarEntry({
              path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
              contents: JSON.stringify(createBackupManifest(payloadPath)),
            }),
            encodeTarEntry({ path: payloadPath, contents: "retained payload\n" }),
            invalidEntry,
            Buffer.alloc(1024),
          ]),
        ),
      );
      const runtime = createTestRuntime();

      await runCommandWithRuntime(runtime, async () => {
        await backupVerifyCommand(runtime, { archive: archivePath });
      });

      expect(runtime.error).toHaveBeenCalledWith(
        `Backup archive verification failed: ${archivePath}. Archive is not a valid OpenClaw backup. ${detail}. Choose another archive or create a new one with \`openclaw backup create\`.`,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "standalone agent asset",
      agentDir: "/tmp/custom-agent",
      coveringAsset: { kind: "agent", sourcePath: "/tmp/custom-agent" },
    },
  ])("verifies the declared agent owner beneath a $name", async ({ agentDir, coveringAsset }) => {
    const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/.openclaw");
    const agentArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, agentDir);
    const manifest = {
      ...createBackupManifest(stateAssetArchivePath),
      paths: {
        stateDir: "/tmp/.openclaw",
        agentRoots: [{ agentId: "main", sourcePath: agentDir }],
      },
      assets: [
        ...createBackupManifest(stateAssetArchivePath).assets,
        ...(coveringAsset
          ? [
              {
                ...coveringAsset,
                archivePath: buildBackupArchivePath(TEST_ARCHIVE_ROOT, coveringAsset.sourcePath),
              },
            ]
          : []),
      ],
    };
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT
        );
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
        VALUES ('primary', 'agent', 1, 'main');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-custom-agent-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        manifest,
        payloads: [
          await createRegisteredAgentPayload("main", `${agentDir}/openclaw-agent.sqlite`),
          {
            fileName: "state.txt",
            contents: "state\n",
            archivePath: `${stateAssetArchivePath}/state.txt`,
          },
          {
            fileName: "openclaw-agent.sqlite",
            contents: sqlitePayload,
            archivePath: `${agentArchivePath}/openclaw-agent.sqlite`,
          },
          ...(coveringAsset?.kind === "workspace"
            ? [
                {
                  fileName: "workspace.sqlite",
                  contents: "workspace SQLite files retain raw-file semantics",
                  archivePath: `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, coveringAsset.sourcePath)}/workspace.sqlite`,
                },
              ]
            : []),
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject(
          { ok: true },
        );
      },
    );
  });

  it.each([
    {
      name: "wrong role",
      role: "global",
      agentId: "main",
      error: /has schema role global; expected agent/iu,
    },
    {
      name: "wrong agent owner",
      role: "agent",
      agentId: "worker",
      error: /belongs to agent worker; requested agent main/iu,
    },
  ])("rejects a custom agent SQLite snapshot with the $name", async ({ role, agentId, error }) => {
    const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/.openclaw");
    const agentDir = "/tmp/workspace/custom-agent";
    const workspaceArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/workspace");
    const manifest = {
      ...createBackupManifest(stateAssetArchivePath),
      paths: {
        stateDir: "/tmp/.openclaw",
        agentRoots: [{ agentId: "main", sourcePath: agentDir }],
      },
      assets: [
        ...createBackupManifest(stateAssetArchivePath).assets,
        { kind: "workspace", sourcePath: "/tmp/workspace", archivePath: workspaceArchivePath },
      ],
    };
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT
        );
      `);
      database
        .prepare(
          "INSERT INTO schema_meta (meta_key, role, schema_version, agent_id) VALUES ('primary', ?, 1, ?)",
        )
        .run(role, agentId);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-custom-agent-owner-",
        manifestAssetArchivePath: stateAssetArchivePath,
        manifest,
        payloads: [
          await createRegisteredAgentPayload("main", `${agentDir}/openclaw-agent.sqlite`),
          {
            fileName: "state.txt",
            contents: "state\n",
            archivePath: `${stateAssetArchivePath}/state.txt`,
          },
          {
            fileName: "openclaw-agent.sqlite",
            contents: sqlitePayload,
            archivePath: `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, agentDir)}/openclaw-agent.sqlite`,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(error);
      },
    );
  });

  it.runIf(process.platform === "win32")(
    "verifies a canonical global SQLite backup beyond MAX_PATH",
    async () => {
      const stateDir = String.raw`C:\Users\OpenClaw\.openclaw`;
      const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir);
      const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
      const sqlitePayload = await createSqlitePayload((database) => {
        database.exec(`
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL
          );
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        `);
      });

      await withBrokenArchiveFixture(
        {
          tempPrefix: "openclaw-backup-windows-long-path-",
          manifestAssetArchivePath: stateAssetArchivePath,
          manifest: createBackupManifest(stateAssetArchivePath, TEST_ARCHIVE_ROOT, stateDir),
          payloads: [
            {
              fileName: "openclaw.sqlite",
              contents: sqlitePayload,
              archivePath: sqliteArchivePath,
            },
          ],
        },
        async (archivePath) => {
          const verificationTempBase = tempDirs.make("openclaw-backup-verify-long-path-");
          let verificationTempRoot = verificationTempBase;
          const resolveMinimumExtractedPath = () =>
            path.join(
              verificationTempRoot,
              "openclaw-backup-verify-sqlite-",
              ...sqliteArchivePath.split("/"),
            );
          while (resolveMinimumExtractedPath().length <= 260) {
            verificationTempRoot = path.join(verificationTempRoot, `segment-${"x".repeat(24)}`);
          }
          await fs.mkdir(verificationTempRoot, { recursive: true });
          expect(verificationTempRoot.startsWith("\\\\?\\")).toBe(false);
          expect(resolveMinimumExtractedPath().length).toBeGreaterThan(260);

          const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(verificationTempRoot);
          try {
            const runtime = createTestRuntime();
            await expect(
              backupVerifyCommand(runtime, { archive: archivePath }),
            ).resolves.toMatchObject({ ok: true });
            await expect(fs.readdir(verificationTempRoot)).resolves.toEqual([]);
          } finally {
            tmpdirSpy.mockRestore();
          }
        },
      );
    },
  );

  it("rejects a structurally valid archive containing a malformed SQLite snapshot", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
    const invalidSqlite = Buffer.from("not a sqlite database", "utf8");

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-invalid-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: invalidSqlite,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const verificationTempRoot = tempDirs.make("openclaw-backup-verify-cleanup-");
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(verificationTempRoot);
        try {
          const runtime = createTestRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            /Backup SQLite snapshot failed verification.*openclaw\.sqlite/iu,
          );
          await expect(fs.readdir(verificationTempRoot)).resolves.toEqual([]);
        } finally {
          tmpdirSpy.mockRestore();
          await fs.rm(verificationTempRoot, { recursive: true, force: true });
        }
      },
    );
  });

  it("rejects an empty canonical SQLite snapshot instead of accepting a new empty database", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-empty-sqlite-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "empty.sqlite",
            contents: new Uint8Array(),
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /SQLite snapshot is empty.*openclaw\.sqlite/iu,
        );
      },
    );
  });

  it("rejects custom-agent SQLite sidecars covered by a workspace asset", async () => {
    const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/.openclaw");
    const agentDir = "/tmp/workspace/custom-agent";
    const agentArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, agentDir);
    const manifest = {
      ...createBackupManifest(stateAssetArchivePath),
      paths: {
        stateDir: "/tmp/.openclaw",
        agentRoots: [{ agentId: "main", sourcePath: agentDir }],
      },
      assets: [
        ...createBackupManifest(stateAssetArchivePath).assets,
        {
          kind: "workspace",
          sourcePath: "/tmp/workspace",
          archivePath: buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/workspace"),
        },
      ],
    };

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-custom-agent-sidecar-",
        manifestAssetArchivePath: stateAssetArchivePath,
        manifest,
        payloads: [
          await createRegisteredAgentPayload("main", `${agentDir}/openclaw-agent.sqlite`),
          {
            fileName: "state.txt",
            contents: "state\n",
            archivePath: `${stateAssetArchivePath}/state.txt`,
          },
          {
            fileName: "openclaw-agent.sqlite-wal",
            contents: "unverified transaction data",
            archivePath: `${agentArchivePath}/openclaw-agent.sqlite-wal`,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /contains a SQLite snapshot sidecar.*openclaw-agent\.sqlite-wal/iu,
        );
      },
    );
  });

  it("rejects case-mangled canonical SQLite paths", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const sqliteArchivePath = `${stateAssetArchivePath}/State/OpenClaw.SQLITE`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-sqlite-case-alias-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /SQLite path with incorrect letter casing.*State\/OpenClaw\.SQLITE/u,
        );
      },
    );
  });

  it("rejects case-mangled aliases of the state asset root", async () => {
    const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
    const statePayloadArchivePath = `${stateAssetArchivePath}/payload.txt`;
    const aliasSidecarArchivePath = `${TEST_ARCHIVE_ROOT}/PAYLOAD/posix/tmp/.openclaw/plugins/dedicated/custom.sqlite-wal`;

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-state-root-case-alias-",
        manifestAssetArchivePath: stateAssetArchivePath,
        payloads: [
          {
            fileName: "payload.txt",
            contents: "payload\n",
            archivePath: statePayloadArchivePath,
          },
          {
            fileName: "custom.sqlite-wal",
            contents: "unverified transaction data",
            archivePath: aliasSidecarArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /case-mangled state asset path.*PAYLOAD.*custom\.sqlite-wal/iu,
        );
      },
    );
  });

  it.each([
    {
      name: "wrong database role",
      schema: `
        CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
      `,
      error: /has role agent; expected global/iu,
    },
    {
      name: "foreign-key corruption",
      schema: `
        PRAGMA foreign_keys = OFF;
        CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
        INSERT INTO children (id, parent_id) VALUES (1, 99);
      `,
      error: /foreign_key_check failed/iu,
    },
  ])(
    "rejects $name in the global database covered by an enclosing agent root",
    async ({ schema, error }) => {
      const agentDir = "/tmp/enclosing-agent";
      const stateDir = `${agentDir}/.openclaw`;
      const agentArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, agentDir);
      const manifest = {
        ...createBackupManifest(agentArchivePath, TEST_ARCHIVE_ROOT, stateDir),
        paths: {
          stateDir,
          agentRoots: [{ agentId: "main", sourcePath: agentDir }],
        },
        assets: [{ kind: "agent", sourcePath: agentDir, archivePath: agentArchivePath }],
      };
      const sqlitePayload = await createSqlitePayload((database) => database.exec(schema));

      await withBrokenArchiveFixture(
        {
          tempPrefix: "openclaw-backup-enclosed-state-sqlite-",
          manifestAssetArchivePath: agentArchivePath,
          manifest,
          payloads: [
            {
              fileName: "openclaw.sqlite",
              contents: sqlitePayload,
              archivePath: `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir)}/state/openclaw.sqlite`,
            },
          ],
        },
        async (archivePath) => {
          await expect(verifyBackupArchive(archivePath)).rejects.toThrow(error);
        },
      );
    },
  );

  it("rejects a state asset root that does not encode its declared source path", async () => {
    const declaredStateAssetRoot = `${TEST_ARCHIVE_ROOT}/payload`;
    const sqliteArchivePath = `${declaredStateAssetRoot}/posix/tmp/.openclaw/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
      `);
    });

    await withBrokenArchiveFixture(
      {
        tempPrefix: "openclaw-backup-state-root-bypass-",
        manifestAssetArchivePath: declaredStateAssetRoot,
        manifest: createBackupManifest(declaredStateAssetRoot),
        payloads: [
          {
            fileName: "openclaw.sqlite",
            contents: sqlitePayload,
            archivePath: sqliteArchivePath,
          },
        ],
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /state asset archivePath does not match its sourcePath/iu,
        );
      },
    );
  });

  it.each([
    {
      name: "temporary space is insufficient",
      availableBytes: 128 * 1024 * 1024,
      simulatedSize: undefined,
      error: /only 128 MiB is available/iu,
    },
    {
      name: "the simulated snapshot size exceeds the hard limit",
      availableBytes: null,
      simulatedSize: 64 * 1024 * 1024 * 1024 + 1,
      error: /verification limit is 64 GiB/iu,
    },
  ])(
    "rejects SQLite extraction before writing when $name",
    async ({ availableBytes, simulatedSize, error }) => {
      const stateAssetArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
      const sqliteArchivePath = `${stateAssetArchivePath}/state/openclaw.sqlite`;
      const sqlitePayload = await createSqlitePayload((database) => {
        database.exec(`
          CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        `);
      });

      await withBrokenArchiveFixture(
        {
          tempPrefix: "openclaw-backup-extraction-budget-",
          manifestAssetArchivePath: stateAssetArchivePath,
          payloads: [
            {
              fileName: "openclaw.sqlite",
              contents: sqlitePayload,
              archivePath: sqliteArchivePath,
            },
          ],
        },
        async (archivePath) => {
          vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) =>
            availableBytes === null
              ? null
              : {
                  targetPath,
                  checkedPath: targetPath,
                  availableBytes,
                  totalBytes: 1024 * 1024 * 1024,
                },
          );
          if (simulatedSize !== undefined) {
            vi.mocked(tar.t).mockImplementation((options) => {
              if (options.filter) {
                return actualTar.t(options);
              }
              return actualTar.t({
                ...options,
                onReadEntry: (entry) => {
                  const originalSize = entry.size;
                  if (entry.path === sqliteArchivePath) {
                    entry.size = simulatedSize;
                  }
                  try {
                    options.onReadEntry?.(entry);
                  } finally {
                    entry.size = originalSize;
                  }
                },
              });
            });
          }
          const mkdtemp = vi.spyOn(fs, "mkdtemp");
          const extract = vi.mocked(tar.x).mockClear();

          await expect(
            backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
          ).rejects.toThrow(error);
          expect(mkdtemp).not.toHaveBeenCalled();
          expect(extract).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("fails when the manifest references a missing asset payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-asset-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      await fs.mkdir(root, { recursive: true });
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
          },
        ],
      };
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [rootName]);

      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /missing payload for manifest asset/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports malformed manifest JSON without leaking parser internals", async () => {
    await createArchiveWithManifestContent(
      {
        tempPrefix: "openclaw-backup-bad-manifest-json-",
        manifestContent: '{"schemaVersion":1,',
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          `Backup archive verification failed: ${archivePath}. Backup manifest is not valid JSON.`,
        );
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.not.toThrow(
          /position|Unexpected|Expected|SyntaxError/u,
        );
      },
    );
  });

  it.each([
    { name: "non-array roots", agentRoots: {}, error: /agentRoots must be an array/u },
    {
      name: "an extra ownership field",
      agentRoots: [{ agentId: "main", sourcePath: "/tmp/agent", owner: "other" }],
      error: /must contain only agentId and sourcePath/u,
    },
    {
      name: "a noncanonical agent id",
      agentRoots: [{ agentId: "Main", sourcePath: "/tmp/agent" }],
      error: /invalid or noncanonical agentId/u,
    },
    {
      name: "a noncanonical UNC agent path",
      agentRoots: [{ agentId: "main", sourcePath: String.raw`\\server\share\agent\..\other` }],
      error: /must be absolute and normalized/u,
    },
    {
      name: "an agent path containing NUL",
      agentRoots: [{ agentId: "main", sourcePath: "/tmp/agent\0suffix" }],
      error: /invalid sourcePath/u,
    },
    {
      name: "case-insensitive Windows drive ownership",
      agentRoots: [
        { agentId: "main", sourcePath: String.raw`C:\OpenClaw\Agent` },
        { agentId: "other", sourcePath: String.raw`c:\openclaw\agent` },
      ],
      error: /duplicate agent root ownership/u,
    },
  ])("rejects $name in backup agent ownership metadata", async ({ agentRoots, error }) => {
    const stateAssetArchivePath = buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/.openclaw");
    const manifest = {
      ...createBackupManifest(stateAssetArchivePath),
      paths: { stateDir: "/tmp/.openclaw", agentRoots },
    };
    await createArchiveWithManifestContent(
      {
        tempPrefix: "openclaw-backup-invalid-agent-roots-",
        manifestContent: JSON.stringify(manifest),
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(error);
      },
    );
  });

  it("rejects oversized manifest entries without retaining the full body", async () => {
    await createArchiveWithManifestContent(
      {
        tempPrefix: "openclaw-backup-huge-manifest-",
        manifestContent: "x".repeat(1024 * 1024 + 1),
      },
      async (archivePath) => {
        const runtime = createTestRuntime();
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
          /Backup manifest exceeds 1048576 byte limit/,
        );
      },
    );
  });

  it("rejects unsafe archive paths", async () => {
    for (const { tempPrefix, archivePath, error } of [
      {
        tempPrefix: "openclaw-backup-traversal-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
        error: /path traversal segments/i,
      },
      {
        tempPrefix: "openclaw-backup-backslash-",
        archivePath: `${TEST_ARCHIVE_ROOT}/payload\\escaped.txt`,
        error: /forward slashes/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix,
          manifestAssetArchivePath: archivePath,
          payloads: [{ fileName: "payload.txt", contents: "payload\n", archivePath }],
        },
        async (brokenArchivePath) => {
          const runtime = createTestRuntime();
          await expect(
            backupVerifyCommand(runtime, { archive: brokenArchivePath }),
          ).rejects.toThrow(error);
        },
      );
    }
  });

  it.each([
    {
      platform: "win32",
      stateDir: "C:\\state",
      workspaceDir: "D:\\credentials",
      kind: "credentials",
    },
  ])(
    "backupVerifyCommand accepts older $platform cross-asset links and checks external records",
    async ({ platform, stateDir, workspaceDir, kind }) => {
      const tempDir = tempDirs.make("openclaw-backup-safe-symlinks-");
      const archivePath = path.join(tempDir, "backup.tar.gz");
      const stateAssetRoot = buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir);
      const workspaceAssetRoot = buildBackupArchivePath(TEST_ARCHIVE_ROOT, workspaceDir);
      const manifest = createBackupManifest(stateAssetRoot, TEST_ARCHIVE_ROOT, stateDir);
      manifest.platform = platform;
      manifest.assets.push({
        kind,
        sourcePath: workspaceDir,
        archivePath: workspaceAssetRoot,
      });
      const archiveEntries = [
        encodeTarEntry({
          path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
          contents: `${JSON.stringify(manifest)}\n`,
        }),
        encodeTarEntry({ path: `${stateAssetRoot}/state.txt`, contents: "state\n" }),
        encodeTarEntry({ path: `${workspaceAssetRoot}/workspace.txt`, contents: "workspace\n" }),
        encodeTarEntry({
          path: `${stateAssetRoot}/workspace-link`,
          type: "SymbolicLink",
          linkpath: path.posix.relative(stateAssetRoot, `${workspaceAssetRoot}/workspace.txt`),
        }),
        encodeTarEntry({
          path: `${stateAssetRoot}/dangling-link`,
          type: "SymbolicLink",
          linkpath: "missing-durable-file.txt",
        }),
      ];
      await fs.writeFile(
        archivePath,
        gzipSync(Buffer.concat([...archiveEntries, Buffer.alloc(1024)])),
      );

      await expect(
        backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
      ).resolves.toMatchObject({
        ok: true,
        assetCount: 2,
        symlinkCount: 2,
        externalSymbolicLinks: [
          {
            entryPath: `${stateAssetRoot}/workspace-link`,
            linkpath: path.posix.relative(stateAssetRoot, `${workspaceAssetRoot}/workspace.txt`),
          },
        ],
      });

      manifest.externalSymbolicLinks = [];
      archiveEntries[0] = encodeTarEntry({
        path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
        contents: `${JSON.stringify(manifest)}\n`,
      });
      await fs.writeFile(
        archivePath,
        gzipSync(Buffer.concat([...archiveEntries, Buffer.alloc(1024)])),
      );
      await expect(
        backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
      ).rejects.toThrow(/external symbolic links do not match archive entries/iu);

      delete manifest.externalSymbolicLinks;
      archiveEntries[0] = encodeTarEntry({
        path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
        contents: `${JSON.stringify(manifest)}\n`,
      });
      archiveEntries.push(
        encodeTarEntry({
          path: `${stateAssetRoot}/escaping-link`,
          type: "SymbolicLink",
          linkpath: "../outside-declared-assets",
        }),
      );
      await fs.writeFile(
        archivePath,
        gzipSync(Buffer.concat([...archiveEntries, Buffer.alloc(1024)])),
      );
      await expect(
        backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
      ).rejects.toThrow(/external symbolic links do not match archive entries/iu);
      manifest.externalSymbolicLinks = [
        {
          entryPath: `${stateAssetRoot}/workspace-link`,
          linkpath: path.posix.relative(stateAssetRoot, `${workspaceAssetRoot}/workspace.txt`),
        },
        {
          entryPath: `${stateAssetRoot}/escaping-link`,
          linkpath: "../outside-declared-assets",
        },
      ];
      archiveEntries[0] = encodeTarEntry({
        path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
        contents: `${JSON.stringify(manifest)}\n`,
      });
      await fs.writeFile(
        archivePath,
        gzipSync(Buffer.concat([...archiveEntries, Buffer.alloc(1024)])),
      );
      await expect(
        backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
      ).resolves.toMatchObject({
        ok: true,
        symlinkCount: 3,
        externalSymbolicLinks: manifest.externalSymbolicLinks,
      });
    },
  );

  it("rejects unsafe hardlink targets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-linkpath-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/target.txt`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /hardlink target.*path traversal segments/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts root-relative internal hardlink targets from older backups", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-rootless-linkpath-"));
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const rootRelativeTargetPath = "payload/posix/tmp/.openclaw/target.txt";
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/${rootRelativeTargetPath}`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: rootRelativeTargetPath,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects hardlink targets missing from archive entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-linkpath-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/target.txt`;
    const hardlinkArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`;
    const missingTargetPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/missing-target.txt`;
    try {
      const archive = gzipSync(
        Buffer.concat([
          encodeTarEntry({
            path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
            contents: `${JSON.stringify(createBackupManifest(payloadArchivePath), null, 2)}\n`,
          }),
          encodeTarEntry({ path: payloadArchivePath, contents: "payload\n" }),
          encodeTarEntry({
            path: hardlinkArchivePath,
            type: "Link",
            linkpath: missingTargetPath,
          }),
          Buffer.alloc(1024),
        ]),
      );
      await fs.writeFile(archivePath, archive);

      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /hardlink target is missing from archive entries/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate manifest and payload entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    for (const options of [
      {
        tempPrefix: "openclaw-backup-duplicate-manifest-",
        payloads: [{ fileName: "payload.txt", contents: "payload\n" }],
        buildTarEntries: ({
          manifestPath,
          payloadPaths,
        }: {
          manifestPath: string;
          payloadPaths: string[];
        }) => [manifestPath, manifestPath, ...payloadPaths],
        error: /expected exactly one backup manifest entry, found 2/i,
      },
      {
        tempPrefix: "openclaw-backup-duplicate-payload-",
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          { fileName: "payload-b.txt", contents: "payload-b\n", archivePath: payloadArchivePath },
        ],
        error: /duplicate entry path/i,
      },
      {
        tempPrefix: "openclaw-backup-portable-path-collision-",
        payloads: [
          { fileName: "payload-a.txt", contents: "payload-a\n", archivePath: payloadArchivePath },
          {
            fileName: "payload-b.txt",
            contents: "payload-b\n",
            archivePath: payloadArchivePath.toUpperCase(),
          },
        ],
        error: /portable path collision/i,
      },
    ]) {
      await withBrokenArchiveFixture(
        {
          tempPrefix: options.tempPrefix,
          manifestAssetArchivePath: payloadArchivePath,
          payloads: options.payloads,
          buildTarEntries: options.buildTarEntries,
        },
        async (archivePath) => {
          const runtime = createTestRuntime();
          await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
            options.error,
          );
        },
      );
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
