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
import { encodeTarEntry } from "./backup-tar.test-support.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { backupVerifyCommand, verifyBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

vi.mock("tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tar")>();
  return { ...actual, t: vi.fn(actual.t), x: vi.fn(actual.x) };
});

const actualTar = await vi.importActual<typeof import("tar")>("tar");

const TEST_ARCHIVE_ROOT = "2026-03-09T00-00-00.000Z-openclaw-backup";
const STATE_ROOT = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`;
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
    paths: { stateDir },
    assets: [{ kind: "state", sourcePath: stateDir, archivePath: assetArchivePath }],
  };
}

function createAgentManifest(
  agentDir: string,
  asset: Pick<BackupManifest["assets"][number], "kind" | "sourcePath">,
): BackupManifest {
  const manifest = createBackupManifest(
    buildBackupArchivePath(TEST_ARCHIVE_ROOT, "/tmp/.openclaw"),
  );
  manifest.paths = {
    stateDir: "/tmp/.openclaw",
    agentRoots: [{ agentId: "main", sourcePath: agentDir }],
  };
  manifest.assets.push({
    ...asset,
    archivePath: buildBackupArchivePath(TEST_ARCHIVE_ROOT, asset.sourcePath),
  });
  return manifest;
}

async function createHardlinkArchive(linkpath: string) {
  const archive = path.join(tempDirs.make("openclaw-backup-hardlink-"), "backup.tar.gz");
  const payloadPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/target.txt`;
  await fs.writeFile(
    archive,
    gzipSync(
      Buffer.concat([
        encodeTarEntry({
          path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
          contents: `${JSON.stringify(createBackupManifest(payloadPath), null, 2)}\n`,
        }),
        encodeTarEntry({ path: payloadPath, contents: "payload\n" }),
        encodeTarEntry({
          path: `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/hardlink.txt`,
          type: "Link",
          linkpath,
        }),
        Buffer.alloc(1024),
      ]),
    ),
  );
  return archive;
}

async function createArchiveWithManifestContent(options: {
  manifestContent: string;
  payloadArchivePath?: string;
}) {
  return await createArchiveFixture({
    manifestContent: options.manifestContent,
    manifestAssetArchivePath:
      options.payloadArchivePath ?? `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`,
    payloads: [{ contents: "payload\n" }],
  });
}

function archivePayload(archivePath: string, contents: string | Uint8Array) {
  return { archivePath, contents };
}

async function createArchiveFixture(options: {
  manifestAssetArchivePath?: string;
  manifest?: ReturnType<typeof createBackupManifest>;
  manifestContent?: string;
  payloads: Array<{ contents: string | Uint8Array; archivePath?: string }>;
  buildTarEntries?: (paths: { manifestPath: string; payloadPaths: string[] }) => string[];
}) {
  const tempDir = tempDirs.make("openclaw-backup-verify-");
  const archivePath = path.join(tempDir, "broken.tar.gz");
  const assetPath = options.manifestAssetArchivePath ?? STATE_ROOT;
  const manifestPath = "manifest";
  const payloadPaths = options.payloads.map((_, index) => `payload-${index}`);
  const entries = new Map([
    [
      manifestPath,
      encodeTarEntry({
        path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
        contents:
          options.manifestContent ??
          JSON.stringify(options.manifest ?? createBackupManifest(assetPath)),
      }),
    ],
    ...options.payloads.map((payload, index): [string, Buffer] => [
      payloadPaths[index]!,
      encodeTarEntry({ path: payload.archivePath ?? assetPath, contents: payload.contents }),
    ]),
  ]);
  const order = options.buildTarEntries?.({ manifestPath, payloadPaths }) ?? [
    manifestPath,
    ...payloadPaths,
  ];
  await fs.writeFile(
    archivePath,
    gzipSync(Buffer.concat([...order.map((name) => entries.get(name)!), Buffer.alloc(1024)])),
  );
  return archivePath;
}

async function expectRejectedArchive(
  options: Parameters<typeof createArchiveFixture>[0],
  error: string | RegExp,
) {
  const archive = await createArchiveFixture(options);
  await expect(backupVerifyCommand(createTestRuntime(), { archive })).rejects.toThrow(error);
}

async function expectRejectedManifest(
  options: Parameters<typeof createArchiveWithManifestContent>[0],
  error: string | RegExp,
) {
  const archive = await createArchiveWithManifestContent(options);
  await expect(backupVerifyCommand(createTestRuntime(), { archive })).rejects.toThrow(error);
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
  return archivePayload(
    `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir)}/state/openclaw.sqlite`,
    await createSqlitePayload((database) => {
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
  );
}

async function agentFixture(
  agentDir: string,
  asset: Parameters<typeof createAgentManifest>[1],
  contents: string | Uint8Array,
  filename = "openclaw-agent.sqlite",
) {
  return {
    manifest: createAgentManifest(agentDir, asset),
    payloads: [
      await createRegisteredAgentPayload("main", `${agentDir}/openclaw-agent.sqlite`),
      archivePayload(`${STATE_ROOT}/state.txt`, "state\n"),
      archivePayload(
        `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, agentDir)}/${filename}`,
        contents,
      ),
    ],
  };
}

const agentPayload = (role: string, agentId: string) =>
  createSqlitePayload((database) => {
    database.exec(`
    CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL,
      schema_version INTEGER NOT NULL, agent_id TEXT);
  `);
    database.prepare("INSERT INTO schema_meta VALUES ('primary', ?, 1, ?)").run(role, agentId);
  });

describe("backupVerifyCommand", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(tar.t).mockReset().mockImplementation(actualTar.t);
    vi.mocked(tar.x).mockReset().mockImplementation(actualTar.x);
  });

  it.each(["first", "last"])("reads the archive once with its manifest %s", async (position) => {
    const archive = path.join(tempDirs.make("openclaw-backup-single-pass-"), "backup.tar.gz");
    const payloadPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    const manifest = encodeTarEntry({
      // Repeated separators are accepted archive spelling, including for a final manifest.
      path: `${TEST_ARCHIVE_ROOT}//manifest.json`,
      contents: JSON.stringify(createBackupManifest(payloadPath)),
    });
    const payload = encodeTarEntry({ path: payloadPath, contents: "payload\n" });
    await fs.writeFile(
      archive,
      gzipSync(
        Buffer.concat([
          ...(position === "first" ? [manifest, payload] : [payload, manifest]),
          Buffer.alloc(1024),
        ]),
      ),
    );

    await expect(verifyBackupArchive(archive)).resolves.toMatchObject({
      ok: true,
      assetCount: 1,
      entryCount: 2,
    });
    // Each file-backed tar listing opens and decompresses the entire gzip stream.
    expect(tar.t).toHaveBeenCalledTimes(1);
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

  it("rejects a missing path header after valid backup entries", async () => {
    const tempDir = tempDirs.make("openclaw-backup-verify-invalid-header-");
    const archivePath = path.join(tempDir, "invalid.tar.gz");
    const payloadPath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/note.txt`;
    const invalidEntry = encodeTarEntry({ path: "", type: "File" });
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
      `Backup archive verification failed: ${archivePath}. Archive is not a valid OpenClaw backup. path is required. Choose another archive or create a new one with \`openclaw backup create\`.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("verifies the declared agent owner beneath a standalone agent asset", async () => {
    const agentDir = "/tmp/custom-agent";
    const archivePath = await createArchiveFixture(
      await agentFixture(
        agentDir,
        { kind: "agent", sourcePath: agentDir },
        await agentPayload("agent", "main"),
      ),
    );
    const runtime = createTestRuntime();
    await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject({
      ok: true,
    });
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
    await expectRejectedArchive(
      await agentFixture(
        "/tmp/workspace/custom-agent",
        { kind: "workspace", sourcePath: "/tmp/workspace" },
        await agentPayload(role, agentId),
      ),
      error,
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
          CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        `);
      });

      const archivePath = await createArchiveFixture({
        manifestAssetArchivePath: stateAssetArchivePath,
        manifest: createBackupManifest(stateAssetArchivePath, TEST_ARCHIVE_ROOT, stateDir),
        payloads: [archivePayload(sqliteArchivePath, sqlitePayload)],
      });
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
        await expect(backupVerifyCommand(runtime, { archive: archivePath })).resolves.toMatchObject(
          { ok: true },
        );
        await expect(fs.readdir(verificationTempRoot)).resolves.toEqual([]);
      } finally {
        tmpdirSpy.mockRestore();
      }
    },
  );

  it("rejects a structurally valid archive containing a malformed SQLite snapshot", async () => {
    const sqliteArchivePath = `${STATE_ROOT}/state/openclaw.sqlite`;
    const invalidSqlite = Buffer.from("not a sqlite database", "utf8");

    const archivePath = await createArchiveFixture({
      payloads: [archivePayload(sqliteArchivePath, invalidSqlite)],
    });
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
  });

  it("rejects an empty canonical SQLite snapshot instead of accepting a new empty database", async () => {
    const sqliteArchivePath = `${STATE_ROOT}/state/openclaw.sqlite`;

    await expectRejectedArchive(
      {
        payloads: [archivePayload(sqliteArchivePath, new Uint8Array())],
      },
      /SQLite snapshot is empty.*openclaw\.sqlite/iu,
    );
  });

  it("rejects custom-agent SQLite sidecars covered by a workspace asset", async () => {
    await expectRejectedArchive(
      await agentFixture(
        "/tmp/workspace/custom-agent",
        { kind: "workspace", sourcePath: "/tmp/workspace" },
        "unverified transaction data",
        "openclaw-agent.sqlite-wal",
      ),
      /contains a SQLite snapshot sidecar.*openclaw-agent\.sqlite-wal/iu,
    );
  });

  it("rejects case-mangled canonical SQLite paths", async () => {
    const sqliteArchivePath = `${STATE_ROOT}/State/OpenClaw.SQLITE`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
      `);
    });

    await expectRejectedArchive(
      {
        payloads: [archivePayload(sqliteArchivePath, sqlitePayload)],
      },
      /SQLite path with incorrect letter casing.*State\/OpenClaw\.SQLITE/u,
    );
  });

  it("rejects case-mangled aliases of the state asset root", async () => {
    const statePayloadArchivePath = `${STATE_ROOT}/payload.txt`;
    const aliasSidecarArchivePath = `${TEST_ARCHIVE_ROOT}/PAYLOAD/posix/tmp/.openclaw/plugins/dedicated/custom.sqlite-wal`;

    await expectRejectedArchive(
      {
        payloads: [
          archivePayload(statePayloadArchivePath, "payload\n"),
          archivePayload(aliasSidecarArchivePath, "unverified transaction data"),
        ],
      },
      /case-mangled state asset path.*PAYLOAD.*custom\.sqlite-wal/iu,
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

      const archivePath = await createArchiveFixture({
        manifestAssetArchivePath: agentArchivePath,
        manifest,
        payloads: [
          archivePayload(
            `${buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir)}/state/openclaw.sqlite`,
            sqlitePayload,
          ),
        ],
      });
      await expect(verifyBackupArchive(archivePath)).rejects.toThrow(error);
    },
  );

  it("rejects a state asset root that does not encode its declared source path", async () => {
    const declaredStateAssetRoot = `${TEST_ARCHIVE_ROOT}/payload`;
    const sqliteArchivePath = `${declaredStateAssetRoot}/posix/tmp/.openclaw/state/openclaw.sqlite`;
    const sqlitePayload = await createSqlitePayload((database) => {
      database.exec(`
        CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'agent');
      `);
    });

    await expectRejectedArchive(
      {
        manifestAssetArchivePath: declaredStateAssetRoot,
        manifest: createBackupManifest(declaredStateAssetRoot),
        payloads: [archivePayload(sqliteArchivePath, sqlitePayload)],
      },
      /state asset archivePath does not match its sourcePath/iu,
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
      const sqliteArchivePath = `${STATE_ROOT}/state/openclaw.sqlite`;
      const sqlitePayload = await createSqlitePayload((database) => {
        database.exec(`
          CREATE TABLE schema_meta (meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL);
          INSERT INTO schema_meta (meta_key, role) VALUES ('primary', 'global');
        `);
      });

      const archivePath = await createArchiveFixture({
        payloads: [archivePayload(sqliteArchivePath, sqlitePayload)],
      });
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

  it("fails when the manifest references a missing asset payload", async () => {
    await expectRejectedArchive(
      {
        manifestAssetArchivePath: `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw`,
        payloads: [],
      },
      /missing payload for manifest asset/i,
    );
  });

  it("reports malformed manifest JSON without leaking parser internals", async () => {
    const archivePath = await createArchiveWithManifestContent({
      manifestContent: '{"schemaVersion":1,',
    });
    const runtime = createTestRuntime();
    await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
      `Backup archive verification failed: ${archivePath}. Backup manifest is not valid JSON.`,
    );
    await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.not.toThrow(
      /position|Unexpected|Expected|SyntaxError/u,
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
    const manifest = {
      ...createBackupManifest(STATE_ROOT),
      paths: { stateDir: "/tmp/.openclaw", agentRoots },
    };
    await expectRejectedManifest(
      {
        manifestContent: JSON.stringify(manifest),
      },
      error,
    );
  });

  it("rejects oversized manifest entries without retaining the full body", async () => {
    const archive = await createArchiveWithManifestContent({
      manifestContent: "x".repeat(1024 * 1024 + 1),
    });
    const collect = vi.spyOn(tar.ReadEntry.prototype, "concat");
    await expect(verifyBackupArchive(archive)).rejects.toThrow(
      /Backup manifest exceeds 1048576 byte limit/u,
    );
    expect(collect).not.toHaveBeenCalled();
  });

  it("rejects unsafe archive paths", async () => {
    for (const { archivePath, error } of [
      {
        archivePath: `${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`,
        error: /path traversal segments/i,
      },
      {
        archivePath: `${TEST_ARCHIVE_ROOT}/payload\\escaped.txt`,
        error: /forward slashes/i,
      },
    ]) {
      const brokenArchivePath = await createArchiveFixture({
        manifestAssetArchivePath: archivePath,
        payloads: [{ contents: "payload\n", archivePath }],
      });
      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: brokenArchivePath })).rejects.toThrow(
        error,
      );
    }
  });

  it("accepts older Windows cross-asset links and checks external records", async () => {
    const stateDir = "C:\\state";
    const workspaceDir = "D:\\credentials";
    const tempDir = tempDirs.make("openclaw-backup-safe-symlinks-");
    const archivePath = path.join(tempDir, "backup.tar.gz");
    const stateAssetRoot = buildBackupArchivePath(TEST_ARCHIVE_ROOT, stateDir);
    const workspaceAssetRoot = buildBackupArchivePath(TEST_ARCHIVE_ROOT, workspaceDir);
    const manifest = createBackupManifest(stateAssetRoot, TEST_ARCHIVE_ROOT, stateDir);
    manifest.platform = "win32";
    manifest.assets.push({
      kind: "credentials",
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
    const writeArchive = async () => {
      archiveEntries[0] = encodeTarEntry({
        path: `${TEST_ARCHIVE_ROOT}/manifest.json`,
        contents: `${JSON.stringify(manifest)}\n`,
      });
      await fs.writeFile(
        archivePath,
        gzipSync(Buffer.concat([...archiveEntries, Buffer.alloc(1024)])),
      );
    };
    await writeArchive();

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
    await writeArchive();
    await expect(
      backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
    ).rejects.toThrow(/external symbolic links do not match archive entries/iu);

    delete manifest.externalSymbolicLinks;
    archiveEntries.push(
      encodeTarEntry({
        path: `${stateAssetRoot}/escaping-link`,
        type: "SymbolicLink",
        linkpath: "../outside-declared-assets",
      }),
    );
    await writeArchive();
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
    await writeArchive();
    await expect(
      backupVerifyCommand(createTestRuntime(), { archive: archivePath }),
    ).resolves.toMatchObject({
      ok: true,
      symlinkCount: 3,
      externalSymbolicLinks: manifest.externalSymbolicLinks,
    });
  });

  it("rejects unsafe hardlink targets", async () => {
    const archive = await createHardlinkArchive(`${TEST_ARCHIVE_ROOT}/payload/../escaped.txt`);
    await expect(backupVerifyCommand(createTestRuntime(), { archive })).rejects.toThrow(
      /hardlink target.*path traversal segments/i,
    );
  });

  it("accepts root-relative internal hardlink targets from older backups", async () => {
    const archive = await createHardlinkArchive("payload/posix/tmp/.openclaw/target.txt");
    await expect(backupVerifyCommand(createTestRuntime(), { archive })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("rejects hardlink targets missing from archive entries", async () => {
    const archive = await createHardlinkArchive(
      `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/missing-target.txt`,
    );
    await expect(backupVerifyCommand(createTestRuntime(), { archive })).rejects.toThrow(
      /hardlink target is missing from archive entries/i,
    );
  });

  it("rejects duplicate manifest and payload entries", async () => {
    const payloadArchivePath = `${TEST_ARCHIVE_ROOT}/payload/posix/tmp/.openclaw/payload.txt`;
    for (const options of [
      {
        payloads: [{ contents: "payload\n" }],
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
        payloads: [
          archivePayload(payloadArchivePath, "payload-a\n"),
          archivePayload(payloadArchivePath, "payload-b\n"),
        ],
        error: /duplicate entry path/i,
      },
      {
        payloads: [
          archivePayload(payloadArchivePath, "payload-a\n"),
          archivePayload(payloadArchivePath.toUpperCase(), "payload-b\n"),
        ],
        error: /portable path collision/i,
      },
    ]) {
      await expectRejectedArchive(
        {
          manifestAssetArchivePath: payloadArchivePath,
          // Inventory failures must win over a manifest body collected earlier in the scan.
          manifestContent: "{invalid",
          payloads: options.payloads,
          buildTarEntries: options.buildTarEntries,
        },
        options.error,
      );
    }
  });
});
