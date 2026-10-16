import fsSync, { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatBackupCreateSummary } from "../commands/backup-summary.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withBackupFixture,
  isolateBackupScratch,
  restoreBackup,
  expectVerifiedBackup,
  expectAbsent,
  createOwnedSqliteDatabase,
  createVerifiedBackup,
  declarePluginSqliteResources,
  expectDatabaseRows,
  inspectDatabase,
  withDatabase,
  writeFiles,
  mkdirs,
} from "./backup-create-family.test-support.js";
import { createBackupArchive, type BackupCreateResult } from "./backup-create.js";
import {
  makeBackupResult,
  createBackupClassificationInventory,
  listArchiveEntries,
  listArchiveEntryDetails,
} from "./backup-create.test-support.js";
import { classifyBackupSqliteSource } from "./backup-sqlite-snapshot.js";
import { writeTarArchiveWithRetry } from "./backup-tar-retry.js";
import * as backupTarWalk from "./backup-tar-walk.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { requireNodeSqlite } from "./node-sqlite.js";

function withBackupState<T>(
  prefix: string,
  fn: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  return withBackupFixture({ prefix }, async (state) => {
    try {
      return await fn(state);
    } finally {
      vi.restoreAllMocks();
    }
  });
}

function createStateArchive(output: string): Promise<BackupCreateResult> {
  return createBackupArchive({ output, includeWorkspace: false, nowMs: Date.UTC(2026, 4, 9, 12) });
}

function expectArchivePath(entries: string[], suffix: string, present: boolean): void {
  expect(
    entries.some((entry) => entry.endsWith(suffix)),
    suffix,
  ).toBe(present);
}

function expectRow(database: import("node:sqlite").DatabaseSync, sql: string, row: unknown) {
  expect(database.prepare(sql).get()).toEqual(row);
}

function schemaVersion(database: import("node:sqlite").DatabaseSync) {
  return {
    user: database.prepare("PRAGMA user_version").get(),
    schema: database
      .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
      .get(),
  };
}

function relativeArchivePath(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/");
}

async function pluginPaths(state: OpenClawTestState, filename: string) {
  await declarePluginSqliteResources(state);
  const dbPath = state.statePath("plugins/dedicated", filename);
  const outputDir = state.path("backups");
  const extractDir = state.path("extract");
  await mkdirs(path.dirname(dbPath), outputDir, extractDir);
  return { dbPath, outputDir, extractDir };
}

async function extractBackup(archive: BackupCreateResult, directory: string) {
  await fs.mkdir(directory, { recursive: true });
  await tar.x({ file: archive.archivePath, gzip: true, cwd: directory });
}

function findArchivePath(entries: string[], suffix: string) {
  return expectDefined(
    entries.find((entry) => entry.endsWith(suffix)),
    suffix,
  );
}

const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);

beforeEach(() => vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1"));

afterEach(() => vi.unstubAllEnvs());

async function withBackupClassificationDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-classify-"));
  try {
    await run(await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createEmptySqliteDatabase(sqlitePath: string): void {
  withDatabase(sqlitePath, (database) => database.exec("VACUUM;"));
}

function registerAgentDatabase(
  state: OpenClawTestState,
  databasePath: string,
  agentId = "main",
): void {
  registerOpenClawAgentDatabase({ agentId, path: databasePath, env: state.env });
  closeOpenClawStateDatabase();
}

function resolveCanonicalTestSqlitePath(
  state: OpenClawTestState,
  kind: "agent" | "global",
): string {
  return kind === "global"
    ? resolveOpenClawStateSqlitePath(state.env)
    : state.statePath("agents/main/agent/openclaw-agent.sqlite");
}

it("formats created archives with included and skipped paths", () => {
  const result = makeBackupResult({
    verified: true,
    skippedVolatileCount: 3,
    assets: [
      {
        kind: "state",
        sourcePath: "/state",
        archivePath: "archive/state",
        displayPath: "~/.openclaw",
      },
    ],
    skipped: [
      {
        kind: "workspace",
        sourcePath: "/workspace",
        displayPath: "~/Projects/openclaw",
        reason: "covered",
        coveredBy: "~/.openclaw",
      },
    ],
  });
  expect(formatBackupCreateSummary(result)).toEqual([
    "Backup archive: /tmp/openclaw-backup.tar.gz",
    "Included 1 path:",
    "- state: ~/.openclaw",
    "Skipped 1 path:",
    "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
    "Created /tmp/openclaw-backup.tar.gz",
    "Skipped 3 volatile files (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).",
    "Archive verification: passed",
  ]);
});

const eof = Object.assign(new Error("encountered unexpected EOF"), {
  code: "EOF",
  path: "/state/logs/gateway.jsonl",
});
it.each<[string, unknown[], RegExp | undefined]>([
  ["non-Error rejection", ["did not encounter expected EOF"], /after 1 attempt\)/],
  ["missing error", [undefined], /after 1 attempt\)/],
  [
    "successful retries",
    [Object.assign(new Error("encountered unexpected EOF"), { code: "EOF" }), eof],
    undefined,
  ],
  [
    "exhausted retries",
    [eof, eof, eof],
    /last offending path: \/state\/logs\/gateway\.jsonl, after 3 attempts/,
  ],
])("preserves retry ownership for %s", async (_name, errors, failure) => {
  const attempts = Math.min(errors.length + (failure ? 0 : 1), 3);
  const backoffs = errors.length > 1 ? [10_000, 20_000] : [];
  const tempArchivePath = "/tmp/backup.tar.gz.tmp";
  const runTar = vi.fn<(pathname: string) => Promise<string>>();
  for (const error of errors) {
    runTar.mockRejectedValueOnce(error);
  }
  runTar.mockResolvedValue("complete");
  const log = vi.fn();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const rmSpy = vi.spyOn(fs, "rm");
  try {
    const result = writeTarArchiveWithRetry({
      tempArchivePath,
      runTar,
      sleepMs: sleep,
      log: failure ? undefined : log,
    });
    if (failure) {
      await expect(result).rejects.toThrow(failure);
      await expect(result).rejects.toThrow(/Backup archive write failed/);
    } else {
      await expect(result).resolves.toBe("complete");
    }
    expect(runTar).toHaveBeenCalledTimes(attempts);
    expect(runTar.mock.calls).toEqual(
      Array.from({ length: attempts }, (_, index) => [
        index === 0 ? tempArchivePath : `${tempArchivePath}.retry-${index + 1}`,
      ]),
    );
    expect(sleep.mock.calls).toEqual(backoffs.map((ms) => [ms]));
    expect(log).toHaveBeenCalledTimes(failure ? 0 : backoffs.length);
    expect(rmSpy).not.toHaveBeenCalled();
  } finally {
    rmSpy.mockRestore();
  }
});

it("filters a volatile file removed after directory discovery", async () => {
  await withBackupState("openclaw-backup-volatile-traversal-", async (state) => {
    const volatilePath = await state.writeText("logs/gateway.log", "live log\n");
    await state.writeText("settings.json", '{"keep":true}\n');
    const readdir = fs.readdir;
    const walk = backupTarWalk.walkBackupTar;
    let archiving = false;
    let removedBeforeStat = false;
    vi.spyOn(backupTarWalk, "walkBackupTar").mockImplementation((params) => {
      archiving = true;
      return walk(params);
    });
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const entries = await readdir(...args);
      // Earlier discovery also lists logs; remove only after the payload walker lists its name.
      if (archiving && args[0] === path.dirname(volatilePath)) {
        rmSync(volatilePath, { force: true });
        removedBeforeStat = true;
      }
      return entries;
    });

    const archive = await createStateArchive(state.path("backup.tar.gz"));
    const entries = await listArchiveEntries(archive.archivePath);
    expect(removedBeforeStat).toBe(true);
    expect(archive.skippedVolatileCount).toBe(1);
    expectArchivePath(entries, "/settings.json", true);
    expectArchivePath(entries, "/logs/gateway.log", false);
  });
});

it.each(["symlink swap", "signature", "short", "read failure", "open validation failure"])(
  "probes metadata safely after %s",
  async (outcome) => {
    await withBackupClassificationDir(async (dir) => {
      const filePath = path.join(dir, "._cron.sqlite");
      const target = path.join(dir, "target");
      const swapping = outcome === "symlink swap";
      await fs.writeFile(
        filePath,
        swapping
          ? Buffer.from("ordinary content")
          : outcome === "short"
            ? APPLE_DOUBLE_MAGIC.subarray(0, 2)
            : APPLE_DOUBLE_MAGIC,
      );
      if (swapping) {
        await fs.writeFile(target, APPLE_DOUBLE_MAGIC);
      }
      const open = fsSync.openSync;
      let descriptor: number | undefined;
      let replaced = false;
      const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
        if (pathname === filePath && swapping) {
          fsSync.unlinkSync(filePath);
          fsSync.symlinkSync(target, filePath);
          replaced = true;
        }
        const fd = open(pathname, flags, mode);
        if (pathname === filePath) {
          descriptor = fd;
        }
        return fd;
      });
      const failedOperation =
        outcome === "read failure"
          ? "readSync"
          : outcome === "open validation failure"
            ? "fstatSync"
            : undefined;
      const failureSpy = failedOperation
        ? vi.spyOn(fsSync, failedOperation).mockImplementation(() => {
            throw new Error("injected probe failure");
          })
        : undefined;
      try {
        expect(classifyBackupSqliteSource(filePath, createBackupClassificationInventory(dir))).toBe(
          outcome === "signature" ? "excluded" : "sqlite",
        );
        if (swapping) {
          expect(replaced).toBe(true);
        }
      } finally {
        openSpy.mockRestore();
        failureSpy?.mockRestore();
      }
      if (!swapping) {
        expect(() =>
          fsSync.fstatSync(expectDefined(descriptor, "metadata probe descriptor")),
        ).toThrow(expect.objectContaining({ code: "EBADF" }));
      }
    });
  },
);

it("excludes AppleDouble metadata only from SQLite-owned roots", async () => {
  await withBackupFixture({}, async (state) => {
    await isolateBackupScratch(state);
    await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
    const opaquePaths = [
      "browser/foreign-browser.sqlite",
      "plugins/dedicated/foreign-plugin.sqlite",
      "agents/Main/agent/foreign-agent.sqlite",
    ];
    for (const file of opaquePaths) {
      await state.writeText(file, "not a database");
    }
    const metadata = Buffer.alloc(163);
    APPLE_DOUBLE_MAGIC.copy(metadata);
    await fs.writeFile(state.statePath("._cron.sqlite"), metadata);
    await fs.writeFile(path.join(state.workspaceDir, "._workspace.sqlite"), metadata);
    await fs.mkdir(state.statePath("._directory.sqlite"));
    await fs.writeFile(state.statePath("._directory.sqlite/keep.txt"), "keep");
    const result = await createBackupArchive({
      output: state.path("backup.tar.gz"),
      includeWorkspace: true,
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(result.archivePath)).mode & 0o777).toBe(0o600);
    }
    const entries = await listArchiveEntries(result.archivePath);
    expectArchivePath(entries, "/state/._cron.sqlite", false);
    expectArchivePath(entries, "/workspace/._workspace.sqlite", true);
    expectArchivePath(entries, "/state/._directory.sqlite/keep.txt", true);
    expect(result.warnings).toHaveLength(opaquePaths.length);
    const restored = await restoreBackup(state, result);
    for (const file of opaquePaths) {
      const entry = findArchivePath(entries, `/state/${file}`);
      expect(
        result.warnings?.filter(
          (warning) => warning.endsWith(path.basename(file)) && warning.includes("opaque"),
        ),
      ).toHaveLength(1);
      expect(await fs.readFile(path.join(restored.targetPath, entry), "utf8")).toBe(
        "not a database",
      );
      expect(await fs.readFile(state.statePath(file), "utf8")).toBe("not a database");
    }
    await expectVerifiedBackup(result);
  });
});

it.each([
  ["openclaw.json.tmp", false],
  ["openclaw.json.tmp", true],
  ["cache.tmp/linked/openclaw.json", false],
] as const)(
  "archives active config bytes at %s (onlyConfig=%s)",
  async (configRelativePath, onlyConfig) => {
    await withBackupFixture(
      { scenario: "empty", prefix: "openclaw-backup-active-config-" },
      async (state) => {
        const volatileParent = configRelativePath.includes("/");
        const configPath = state.statePath(...configRelativePath.split("/"));
        const configRaw = onlyConfig ? '{"gateway":' : '{"gateway":{"mode":"local"}}\n';
        state.envVars.OPENCLAW_CONFIG_PATH = configPath;
        state.applyEnv();
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, configRaw);
        await writeFiles(state.stateDir, {
          "logs/live.log": "live log\n",
          "scratch.tmp": "temporary state\n",
          "sandbox/skills-workspaces/other/generated.json": "generated state\n",
        });
        await writeFiles(path.dirname(configPath), {
          "neighbor.tmp": "temporary\n",
          "neighbor.json": "{}\n",
        });
        if (volatileParent && process.platform !== "win32") {
          const target = state.path("unrelated.txt");
          await fs.writeFile(target, "unrelated synthetic file\n");
          await fs.symlink(target, path.join(path.dirname(configPath), "absolute-link"));
        }

        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
          onlyConfig,
        });
        const entries = await listArchiveEntries(archive.archivePath);
        const configEntries = entries.filter((entry) =>
          entry.endsWith(`/state/${configRelativePath}`),
        );
        expect(configEntries).toHaveLength(1);
        expectArchivePath(entries, "/live.log", false);
        expect(
          entries.some((entry) => entry.endsWith(".tmp") && !configEntries.includes(entry)),
        ).toBe(false);
        expect(entries.some((entry) => entry.includes("/skills-workspaces/other"))).toBe(false);
        expect(entries.some((entry) => entry.endsWith("/neighbor.json"))).toBe(
          !onlyConfig && !volatileParent,
        );
        expectArchivePath(entries, "/absolute-link", false);
        if (onlyConfig) {
          expect(entries).toHaveLength(2);
        }

        const extractDir = state.path("extract");
        await extractBackup(archive, extractDir);
        const configEntry = expectDefined(configEntries[0], "active config archive entry");
        expect(await fs.readFile(path.join(extractDir, configEntry), "utf8")).toBe(configRaw);
        await expectVerifiedBackup(archive);
      },
    );
  },
);

it
  .runIf(process.platform !== "win32")
  .each(["state ancestor", "config ancestor", "incomplete metadata", "escaping metadata"])(
  "does not declare a managed-skill target with %s",
  async (kind) => {
    await withBackupState("openclaw-backup-skill-boundary-", async (state) => {
      const root = await fs.realpath(state.root);
      const target = kind === "state ancestor" ? root : path.join(root, "broad-skill");
      await fs.mkdir(target, { recursive: true });
      if (kind === "config ancestor") {
        state.envVars.OPENCLAW_CONFIG_PATH = path.join(target, "openclaw.json");
        state.applyEnv();
        await fs.writeFile(state.envVars.OPENCLAW_CONFIG_PATH, "{}\n");
      }
      const metadata = path.join(target, "SKILL.md");
      if (kind === "escaping metadata") {
        await state.writeText("payload.md", "state payload\n");
        await fs.symlink(path.relative(target, state.statePath("payload.md")), metadata);
      } else {
        await fs.writeFile(
          metadata,
          kind === "incomplete metadata"
            ? "---\nname: broad\n---\n"
            : "---\nname: broad\ndescription: Broad target\n---\n",
        );
      }
      await fs.writeFile(path.join(target, "unrelated.txt"), "do not archive\n");
      const link = state.statePath("skills/broad");
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(path.relative(path.dirname(link), target), link, "dir");
      const result = await createVerifiedBackup(state);
      const entries = await listArchiveEntryDetails(result.archivePath);
      expect(result.assets.some((asset) => asset.kind === "managed skill")).toBe(false);
      expect(entries.some((entry) => entry.path.endsWith("/SKILL.md"))).toBe(false);
      expect(entries.filter((entry) => entry.type === "SymbolicLink")).toHaveLength(1);
      expect(result.externalSymbolicLinks).toHaveLength(1);
    });
  },
);

it("safely snapshots, verifies, and restores a custom agent nested in the default layout", async () => {
  await withBackupState("openclaw-backup-owned-agent-sqlite-", async (state) => {
    const agentDir = state.statePath("agents/main/agent/custom-agent");
    const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
    const durableAgentDirectories = [
      "tmp",
      ".tmp",
      "runtime-home/tmp",
      "runtime-home/.tmp",
      "tmp-data",
      ".tmp-data",
    ];
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "durable-agent-state.json"), "{}\n");
    await state.writeText("plugin-skills/generated-skill.md", "generated\n");
    await state.writeConfig({ agents: { entries: { main: { agentDir } } } });
    await writeFiles(
      agentDir,
      Object.fromEntries(
        durableAgentDirectories.map((dirname) => [`${dirname}/durable.txt`, "keep\n"]),
      ),
    );
    createOwnedSqliteDatabase({ sqlitePath: dbPath, role: "agent", agentId: "main" });
    registerAgentDatabase(state, dbPath);

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(dbPath);
    let archive: BackupCreateResult;
    const lstatSpy = vi.spyOn(fs, "lstat");
    try {
      db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE durable_records (value TEXT NOT NULL);
            INSERT INTO durable_records VALUES ('checkpointed');
            PRAGMA wal_checkpoint(TRUNCATE);
            INSERT INTO durable_records VALUES ('committed-in-wal');
          `);
      await fs.access(`${dbPath}-wal`);
      await fs.access(`${dbPath}-shm`);

      archive = await createBackupArchive({
        output: state.path("owned-agent.tar.gz"),
        includeWorkspace: false,
      });
      const inspectedPaths = lstatSpy.mock.calls.map(([target]) => target);
      expect(inspectedPaths).not.toContain(`${dbPath}-wal`);
      expect(inspectedPaths).not.toContain(`${dbPath}-shm`);
    } finally {
      lstatSpy.mockRestore();
      db.close();
    }

    const entries = await listArchiveEntries(archive.archivePath);
    expectArchivePath(entries, "/custom-agent/durable-agent-state.json", true);
    expect(entries.some((entry) => entry.includes("/plugin-skills/"))).toBe(false);
    const archivedDbEntry = findArchivePath(entries, "/custom-agent/openclaw-agent.sqlite");
    expectArchivePath(entries, "/openclaw-agent.sqlite-wal", false);
    expectArchivePath(entries, "/openclaw-agent.sqlite-shm", false);
    for (const dirname of durableAgentDirectories) {
      expectArchivePath(entries, `/custom-agent/${dirname}/durable.txt`, true);
    }

    const restore = await restoreBackup(state, archive);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(restore.targetPath, archive.archiveRoot, "manifest.json"),
        "utf8",
      ),
    ) as {
      paths: { agentRoots: Array<{ agentId: string; sourcePath: string }> };
      skipped: Array<Record<string, unknown>>;
    };
    expect(manifest.paths.agentRoots).toContainEqual({ agentId: "main", sourcePath: agentDir });
    expect(manifest.skipped).toEqual(
      archive.skipped.map(({ kind, sourcePath, reason, coveredBy }) =>
        Object.assign({ kind, sourcePath, reason }, coveredBy ? { coveredBy } : {}),
      ),
    );
    const restoredDbPath = path.join(restore.targetPath, archivedDbEntry);
    if (process.platform !== "win32") {
      expect((await fs.stat(restoredDbPath)).mode & 0o777).toBe(0o600);
    }
    expectDatabaseRows(restoredDbPath, "SELECT value FROM durable_records ORDER BY value", [
      { value: "checkpointed" },
      { value: "committed-in-wal" },
    ]);
  });
});

it("applies activated manifest-owned exclusions before SQLite and symlink handling", async () => {
  await withBackupState("openclaw-backup-plugin-resource-", async (state) => {
    const agentDir = state.path("external-agent");
    const pluginRoot = state.path("synthetic-backup-plugin");
    const excludedStateRoot = state.statePath("generated");
    const excludedAgentRoot = path.join(agentDir, "codex-home/tmp/arg0");
    await mkdirs(pluginRoot);
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "backup-owner",
      manifest: {
        backupResources: [
          { disposition: "regenerable", scope: "state", relativePath: "generated" },
          { disposition: "include", scope: "state", relativePath: "generated/protected" },
          { disposition: "regenerable", scope: "state", relativePath: "state/openclaw.sqlite" },
          { disposition: "regenerable", scope: "agent", relativePath: "openclaw-agent.sqlite" },
          { disposition: "regenerable", scope: "agent", relativePath: "codex-home/tmp/arg0" },
          {
            disposition: "include",
            scope: "agent",
            relativePath: "codex-home/tmp/arg0/protected",
          },
        ],
      },
    });
    await writeFiles(excludedStateRoot, {
      "unsafe.sqlite": "not sqlite\n",
      "protected/keep.txt": "keep\n",
    });
    await writeFiles(agentDir, {
      "codex-home/tmp/arg0/unsafe.sqlite": "not sqlite\n",
      "codex-home/tmp/arg0/protected/keep.txt": "keep\n",
      "codex-home/tmp/arg0-data/keep.txt": "keep\n",
      "codex-home/.tmp-data/keep.txt": "keep\n",
    });
    if (process.platform !== "win32") {
      await fs.symlink("/outside-backup", path.join(excludedAgentRoot, "unsafe-link"));
    }
    await state.writeConfig({
      agents: { entries: { main: { agentDir } } },
      plugins: { load: { paths: [pluginRoot] }, entries: { "backup-owner": { enabled: true } } },
    });
    const globalDbPath = resolveCanonicalTestSqlitePath(state, "global");
    const agentDbPath = path.join(agentDir, "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(globalDbPath), { recursive: true });
    createOwnedSqliteDatabase({ sqlitePath: agentDbPath, role: "agent", agentId: "main" });
    registerAgentDatabase(state, agentDbPath);

    const result = await createStateArchive(state.path("plugin-owned.tar.gz"));
    const entries = await listArchiveEntries(result.archivePath);

    for (const suffix of [
      "/state/state/openclaw.sqlite",
      "/state/generated/protected/keep.txt",
      "/external-agent/openclaw-agent.sqlite",
      "/external-agent/codex-home/tmp/arg0/protected/keep.txt",
      "/external-agent/codex-home/tmp/arg0-data/keep.txt",
      "/external-agent/codex-home/.tmp-data/keep.txt",
    ]) {
      expectArchivePath(entries, suffix, true);
    }
    expectArchivePath(entries, "/unsafe.sqlite", false);
    expectArchivePath(entries, "/unsafe-link", false);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ sourcePath: excludedAgentRoot, reason: "regenerable" }),
    );
  });
});

it("skips current live volatile state files while preserving workspace locks", async () => {
  await withBackupFixture(
    { layout: "split", prefix: "openclaw-backup-volatile-" },
    async (state) => {
      const outputDir = state.path("backups");
      await state.writeConfig({
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      });
      await fs.mkdir(outputDir, { recursive: true });
      await writeFiles(state.workspaceDir, {
        "Cargo.lock": "workspace lock\n",
        "pending.tmp": "workspace temp fixture\n",
      });
      const volatileFiles = [
        "agents/main/sessions/live-session.jsonl",
        "sessions/legacy-session.jsonl",
        "cron/runs/nightly.jsonl",
        "logs/gateway.log",
        "delivery-queue/message.json",
        "delivery-queue/message.delivered",
        "session-delivery-queue/message.json",
        "session-delivery-queue/message.delivered",
        "tmp/staged.tmp",
        "gateway.pid",
      ];
      await writeFiles(
        state.stateDir,
        Object.fromEntries(volatileFiles.map((file) => [file, "{}\n"])),
      );

      const result = await createBackupArchive({
        output: outputDir,
        includeWorkspace: true,
        nowMs: Date.UTC(2026, 4, 9, 8, 0, 0),
      });
      const entries = await listArchiveEntries(result.archivePath);

      expectArchivePath(entries, "/workspace/Cargo.lock", true);
      expectArchivePath(entries, "/workspace/pending.tmp", false);
      for (const file of volatileFiles) {
        expectArchivePath(entries, `/state/${file}`, false);
      }
      expect(result.skippedVolatileCount).toBe(10);
    },
  );
});

it("creates a verifiable archive for highly compressible sparse state", async () => {
  await withBackupState("openclaw-backup-sparse-state-", async (state) => {
    const outputDir = state.path("backups");
    const sparsePath = state.statePath("sparse-state.bin");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(sparsePath, "");
    await fs.truncate(sparsePath, 256 * 1024 * 1024);

    const result = await createStateArchive(outputDir);
    await expectVerifiedBackup(result);
  });
});

it("rejects repairable task-delivery orphans before creating a backup archive", async () => {
  await withBackupState("openclaw-backup-foreign-key-", async (state) => {
    const outputDir = state.path("backups");
    await fs.mkdir(outputDir, { recursive: true });
    openOpenClawStateDatabase({ env: state.env });
    closeOpenClawStateDatabase();

    let originalVersion: unknown;
    withDatabase(resolveOpenClawStateSqlitePath(state.env), (database) => {
      originalVersion = schemaVersion(database);
      database.exec("PRAGMA foreign_keys = OFF;");
      database.prepare("INSERT INTO task_delivery_state (task_id) VALUES (?)").run("missing-task");
      expectRow(database, "PRAGMA quick_check", { quick_check: "ok" });
      expectRow(database, "PRAGMA integrity_check", { integrity_check: "ok" });
    });

    await expect(createStateArchive(outputDir)).rejects.toThrow(
      /repairable task_delivery_state\.task_id references task_runs\.task_id.*\(1 rows\).*openclaw doctor --fix/iu,
    );
    expect(await fs.readdir(outputDir)).toEqual([]);
    inspectDatabase(resolveOpenClawStateSqlitePath(state.env), (unchanged) => {
      expect(unchanged.prepare("SELECT task_id FROM task_delivery_state").all()).toEqual([
        { task_id: "missing-task" },
      ]);
      expect(unchanged.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
      expect(schemaVersion(unchanged)).toEqual(originalVersion);
    });
  });
});

it.each<["global" | "agent", "empty" | "schema-empty" | "global" | "agent", string?, boolean?]>([
  ["agent", "agent", "other", true],
  ["global", "empty"],
  ["agent", "empty"],
  ["global", "schema-empty"],
  ["agent", "schema-empty"],
  ["global", "agent", "main"],
  ["agent", "global"],
  ["agent", "agent", "worker"],
  ["agent", "agent", "Main"],
])(
  "rejects %s DB with %s shape (owner=%s, external=%s) without changing bytes",
  async (kind, shape, agentId, external) => {
    const expected =
      shape === "empty"
        ? /snapshot source must not be empty/iu
        : shape === "schema-empty"
          ? /schema role missing|no schema ownership metadata/iu
          : shape !== kind
            ? new RegExp(`schema role ${shape}; expected ${kind}`, "iu")
            : new RegExp(`belongs to agent ${agentId}; requested agent main`, "iu");
    await withBackupState("openclaw-backup-invalid-owner-", async (state) => {
      const outputDir = state.path("backups");
      const dbPath = external
        ? state.path("external-agent/openclaw-agent.sqlite")
        : resolveCanonicalTestSqlitePath(state, kind);
      if (external) {
        await state.writeConfig({
          agents: { entries: { main: { agentDir: path.dirname(dbPath) } } },
        });
      }
      await mkdirs(path.dirname(dbPath), outputDir);
      if (kind === "agent") {
        registerAgentDatabase(state, dbPath);
      }
      if (shape === "empty") {
        await fs.writeFile(dbPath, "");
      } else if (shape === "schema-empty") {
        createEmptySqliteDatabase(dbPath);
      } else {
        createOwnedSqliteDatabase({ sqlitePath: dbPath, role: shape, agentId });
      }
      const sourceBytes = await fs.readFile(dbPath);
      const recordOutcome = backupRunRecords.recordBackupRunOutcome;
      let bytesBeforeOutcome: Buffer | undefined;
      const outcomeSpy = vi
        .spyOn(backupRunRecords, "recordBackupRunOutcome")
        .mockImplementation(async (params, options) => {
          bytesBeforeOutcome = await fs.readFile(dbPath);
          await recordOutcome(params, options);
        });

      await expect(
        backupCreateCommand(createTestRuntime(), {
          output: outputDir,
          includeWorkspace: false,
        }),
      ).rejects.toThrow(expected);
      expect(outcomeSpy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "failed" }),
        expect.objectContaining({
          assertCurrent: expect.any(Function),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(bytesBeforeOutcome).toEqual(sourceBytes);
      expect(await fs.readFile(dbPath)).toEqual(sourceBytes);
      expect(await fs.readdir(outputDir)).toEqual([]);
    });
  },
);

it.runIf(process.platform !== "win32")(
  "fails closed when a canonical SQLite symlink retargets after discovery",
  async () => {
    await withBackupState("openclaw-backup-canonical-symlink-retarget-", async (state) => {
      const outputDir = state.path("backups");
      const canonicalDbPath = resolveCanonicalTestSqlitePath(state, "global");
      const firstDbPath = state.statePath("state/first-global.sqlite");
      const secondDbPath = state.statePath("state/second-global.sqlite");
      await mkdirs(path.dirname(canonicalDbPath), outputDir);
      createOwnedSqliteDatabase({ sqlitePath: firstDbPath, role: "global" });
      createOwnedSqliteDatabase({ sqlitePath: secondDbPath, role: "global" });
      await fs.symlink(firstDbPath, canonicalDbPath);

      const originalRealpath = fs.realpath.bind(fs);
      let retargeted = false;
      vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
        const resolved = await originalRealpath(target);
        if (!retargeted && path.resolve(String(target)) === path.resolve(canonicalDbPath)) {
          retargeted = true;
          await fs.unlink(canonicalDbPath);
          await fs.symlink(secondDbPath, canonicalDbPath);
        }
        return resolved;
      });

      await expect(createStateArchive(outputDir)).rejects.toThrow(
        /Canonical SQLite path changed after discovery/iu,
      );
      expect(retargeted).toBe(true);
      expect(await fs.readdir(outputDir)).toEqual([]);
    });
  },
);

it.each(["cache.lock.sqlite", "._cron.sqlite"])(
  "snapshots declared SQLite %s with transaction continuity",
  async (filename) => {
    await withBackupState("openclaw-backup-nested-sqlite-", async (state) => {
      const { dbPath, outputDir, extractDir } = await pluginPaths(state, filename);
      const sqlite = requireNodeSqlite();
      using db = new sqlite.DatabaseSync(dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE backup_meta (id INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL);
        CREATE TABLE backup_markers (seq INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL);
        CREATE TABLE delivery_queue_entries (id TEXT PRIMARY KEY);
        CREATE TABLE state_leases (scope TEXT NOT NULL, lease_key TEXT NOT NULL);
        INSERT INTO backup_meta (id, last_seq) VALUES (1, 0);
        INSERT INTO delivery_queue_entries (id) VALUES ('must-stay');
        INSERT INTO state_leases (scope, lease_key) VALUES ('plugin-owned', 'must-stay');
        PRAGMA wal_checkpoint(TRUNCATE);
        BEGIN IMMEDIATE;
        INSERT INTO backup_markers (seq, transaction_id) VALUES (1, 7), (2, 7), (3, 7);
        UPDATE backup_meta SET last_seq = 3 WHERE id = 1;
        COMMIT;
      `);
      await fs.writeFile(`${dbPath}-journal`, "");

      await fs.access(`${dbPath}-wal`);
      await fs.access(`${dbPath}-shm`);
      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);
      const archivedDbEntries = entries.filter((entry) =>
        entry.endsWith(`/state/plugins/dedicated/${filename}`),
      );
      expect(archivedDbEntries).toHaveLength(1);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expectArchivePath(entries, `/state/plugins/dedicated/${filename}${suffix}`, false);
      }

      await extractBackup(result, extractDir);
      inspectDatabase(
        path.join(extractDir, expectDefined(archivedDbEntries[0], "archived database")),
        (archivedDb) => {
          expectRow(archivedDb, "PRAGMA integrity_check", { integrity_check: "ok" });
          expectRow(archivedDb, "SELECT last_seq FROM backup_meta WHERE id = 1", {
            last_seq: 3,
          });
          expectRow(
            archivedDb,
            "SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM backup_markers",
            { count: 3, min_seq: 1, max_seq: 3 },
          );
          for (const table of ["delivery_queue_entries", "state_leases"]) {
            expectRow(archivedDb, `SELECT COUNT(*) AS count FROM ${table}`, { count: 1 });
          }
        },
      );
    });
  },
);

it("fails closed when a plugin SQLite schema cannot be compacted safely", async () => {
  await withBackupState("openclaw-backup-plugin-capability-", async (state) => {
    const { dbPath, outputDir } = await pluginPaths(state, "custom.sqlite");
    withDatabase(dbPath, (db) => {
      db.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
      db.exec(`
        CREATE TABLE records (value INTEGER NOT NULL);
        INSERT INTO records (value) VALUES (1), (2);
        CREATE INDEX records_double ON records(plugin_double(value));
      `);
    });

    await expect(createStateArchive(outputDir)).rejects.toThrow(
      /cannot be compacted safely.*custom\.sqlite/iu,
    );
  });
});

it("fails instead of raw-copying malformed declared plugin SQLite databases: ._cron.sqlite", async () => {
  await withBackupState("openclaw-backup-malformed-sqlite-", async (state) => {
    const { dbPath, outputDir } = await pluginPaths(state, "._cron.sqlite");
    await fs.writeFile(dbPath, "not a sqlite database", "utf8");

    await expect(createStateArchive(outputDir)).rejects.toThrow(
      /file is not a database|malformed/i,
    );
  });
});

it("fails when declared plugin SQLite appears after snapshot discovery: late.sqlite", async () => {
  await withBackupState("openclaw-backup-late-sqlite-", async (state) => {
    const { dbPath: latePath, outputDir } = await pluginPaths(state, "late.sqlite");

    const originalReaddir = fs.readdir.bind(fs);
    let createdLatePath = false;
    let stagedArchiveCleanupAttempts = 0;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      const entries = await (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(
        ...args,
      );
      if (
        !createdLatePath &&
        path.resolve(String(args[0])) === path.resolve(path.dirname(latePath))
      ) {
        createdLatePath = true;
        await fs.writeFile(latePath, "late SQLite state");
      }
      return entries;
    }) as typeof fs.readdir);
    const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
      const targetPath = path.resolve(String(target));
      if (
        targetPath.startsWith(path.resolve(outputDir)) &&
        targetPath.includes(".openclaw-backup-publish-")
      ) {
        stagedArchiveCleanupAttempts += 1;
        if (stagedArchiveCleanupAttempts === 1) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
      }
      return originalUnlinkSync(target);
    });

    await expect(createStateArchive(outputDir)).rejects.toThrow(
      /SQLite state appeared after snapshot discovery/,
    );
    expect(createdLatePath).toBe(true);
    expect(stagedArchiveCleanupAttempts).toBeGreaterThanOrEqual(2);
    expect(await fs.readdir(outputDir)).toEqual([]);
  });
});

it("excludes the state-local gateway lock tree while backing up durable SQLite", async () => {
  await withBackupState("openclaw-backup-gateway-lock-sqlite-", async (state) => {
    await declarePluginSqliteResources(state);
    const outputDir = state.path("backups");
    const extractDir = state.path("extract");
    const lockDir = resolveGatewayLockDir(state.stateDir);
    const pluginDbPath = state.statePath("plugins/dedicated/durable.sqlite");
    const producerShapedDbPath = state.statePath("plugins/dedicated/gateway.12345678.lock.sqlite");
    const colocatedDbPath = path.join(lockDir, "retained.sqlite");
    await mkdirs(outputDir, extractDir, path.dirname(pluginDbPath), lockDir);

    for (const [databasePath, value] of [
      [pluginDbPath, "plugin-state"],
      [producerShapedDbPath, "producer-shaped-state"],
      [colocatedDbPath, "colocated-state"],
    ] as const) {
      withDatabase(databasePath, (database) => {
        database.exec("CREATE TABLE durable_state (value TEXT NOT NULL)");
        database.prepare("INSERT INTO durable_state (value) VALUES (?)").run(value);
      });
    }

    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env: state.env,
      lockDir,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test gateway lock");
    }
    const gatewayCoordinatorPaths = [
      `${gatewayLock.lockPath}.sqlite`,
      `${gatewayLock.stateLockPath}.sqlite`,
    ];
    const extraTransientPaths = [
      path.join(lockDir, "device-identity.12345678.lock.sqlite"),
      state.statePath("memory/main.sqlite.reindex-lock.sqlite"),
    ];

    try {
      for (const transientPath of [...gatewayCoordinatorPaths, ...extraTransientPaths]) {
        await fs.mkdir(path.dirname(transientPath), { recursive: true });
        if (!gatewayCoordinatorPaths.includes(transientPath)) {
          await fs.writeFile(transientPath, "transient coordinator database");
        }
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await fs.writeFile(`${transientPath}${suffix}`, "transient coordinator sidecar");
        }
      }

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);
      for (const transientPath of [...gatewayCoordinatorPaths, ...extraTransientPaths]) {
        const relativeTransientPath = relativeArchivePath(state.stateDir, transientPath);
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          expectArchivePath(entries, `/state/${relativeTransientPath}${suffix}`, false);
        }
      }
      expectArchivePath(entries, "/state/plugins/dedicated/durable.sqlite", true);
      expectArchivePath(entries, "/state/plugins/dedicated/gateway.12345678.lock.sqlite", true);
      expect(entries.some((entry) => entry.includes(`/${path.basename(lockDir)}/`))).toBe(false);

      await expectVerifiedBackup(result);

      await extractBackup(result, extractDir);
      for (const [entrySuffix, value] of [
        ["/state/plugins/dedicated/durable.sqlite", "plugin-state"],
        ["/state/plugins/dedicated/gateway.12345678.lock.sqlite", "producer-shaped-state"],
      ] as const) {
        const archivedEntry = findArchivePath(entries, entrySuffix);
        expectDatabaseRows(
          path.join(extractDir, archivedEntry),
          "SELECT value FROM durable_state",
          [{ value }],
        );
      }
    } finally {
      await gatewayLock.release();
    }
  });
});

it
  .runIf(process.platform !== "win32")
  .each([
    "dangling absolute",
    "external relative",
    "internal relative",
    "cyclic relative",
    "valid marked directory",
    "malformed marked directory",
    "unreadable marked directory",
  ])("backup/restore preserves privacy for %s links", async (label) => {
  const relative = label.endsWith("relative");
  const cyclic = label === "cyclic relative";
  const internal = cyclic || label === "internal relative";
  const targetExists = relative && !cyclic;
  const marker = label.endsWith("marked directory") ? label.split(" ")[0] : undefined;
  await withBackupState("openclaw-backup-symbolic-link-", async (state) => {
    const targetPath = internal ? state.statePath("target.txt") : state.path("outside-target");
    if (marker) {
      await fs.mkdir(targetPath);
      await fs.writeFile(path.join(targetPath, "external.txt"), "outside\n");
      await fs.writeFile(
        path.join(targetPath, ".openclaw-private-update-capture"),
        marker === "malformed" ? "invalid" : "openclaw-private-update-capture-v1\n",
        { mode: marker === "unreadable" ? 0o000 : 0o600 },
      );
    } else if (targetExists) {
      await fs.writeFile(targetPath, "target\n");
    }
    const linkpath = relative ? path.relative(state.stateDir, targetPath) : targetPath;
    await fs.symlink(linkpath, state.statePath("ordinary-link"));
    if (cyclic) {
      await fs.symlink("ordinary-link", targetPath);
    }
    const runtime = createTestRuntime();
    const output = state.path("backup.tar.gz");
    const create = () =>
      backupCreateCommand(runtime, { output, includeWorkspace: false, verify: true });
    if (marker && marker !== "valid") {
      await expect(create()).rejects.toThrow("Private update capture marker");
      await expectAbsent(output);
      return;
    }
    const result = await create();
    const entries = await listArchiveEntryDetails(result.archivePath);
    if (marker) {
      expect(
        entries.some(
          (entry) =>
            entry.path.endsWith("/ordinary-link") || entry.path.includes("/outside-target"),
        ),
      ).toBe(false);
      expect(result.externalSymbolicLinks ?? []).toEqual([]);
      const { targetPath: restored } = await restoreBackup(state, result, runtime);
      const asset = expectDefined(
        result.assets.find((candidate) => candidate.kind === "state"),
        "state asset",
      );
      await expect(
        fs.lstat(path.join(restored, asset.archivePath, "ordinary-link")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    const link = expectDefined(
      entries.find((entry) => entry.path.endsWith("/state/ordinary-link")),
      "archived ordinary link",
    );
    expect(link).toMatchObject({ type: "SymbolicLink", linkpath });
    expect(entries.some((entry) => entry.path.includes("/outside-target"))).toBe(false);
    const externalSymbolicLinks = internal ? [] : [{ entryPath: link.path, linkpath }];
    expect(result.externalSymbolicLinks ?? []).toEqual(externalSymbolicLinks);
    expect(result.verified).toBe(true);
    if (!internal) {
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(linkpath)));
    }
    const { targetPath: restored } = await restoreBackup(state, result, runtime);
    const restoredLink = path.join(restored, link.path);
    expect(await fs.readlink(restoredLink)).toBe(linkpath);
    if (cyclic) {
      expect(await fs.readlink(path.join(path.dirname(restoredLink), "target.txt"))).toBe(
        "ordinary-link",
      );
    } else if (internal) {
      expect(await fs.readFile(restoredLink, "utf8")).toBe("target\n");
    } else if (!targetExists) {
      await expectAbsent(restoredLink);
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(restored, result.archiveRoot, "manifest.json"), "utf8"),
    );
    expect(manifest.externalSymbolicLinks ?? []).toEqual(externalSymbolicLinks);
  });
});

it.runIf(process.platform !== "win32").each([
  { label: "backslash config", kind: "config" as const, hops: 1, backslash: true },
  { label: "relative config", kind: "config" as const, hops: 1, relative: true },
  { label: "chained credentials", kind: "credentials" as const, hops: 2 },
  { label: "volatile-path config", kind: "config" as const, hops: 1, volatile: true },
])(
  "backupCreateCommand and backupRestoreCommand preserve the first hop of a $label link",
  async ({ kind, hops, volatile, relative, backslash }) => {
    await withBackupState("openclaw-backup-declared-config-symlink-", async (state) => {
      const outputPath = state.path(`declared-${kind}-symlink.tar.gz`);
      const restorePath = state.path("restored");
      const sourcePath = volatile
        ? state.statePath("cache.tmp/managed", kind === "config" ? "openclaw.json" : "credentials")
        : kind === "config"
          ? state.configPath
          : state.statePath("credentials");
      if (volatile) {
        if (kind === "config") {
          state.envVars.OPENCLAW_CONFIG_PATH = sourcePath;
        } else {
          state.envVars.OPENCLAW_OAUTH_DIR = sourcePath;
        }
        state.applyEnv();
        await writeFiles(path.dirname(sourcePath), {
          "neighbor.tmp": "omit\n",
          "neighbor.json": "omit\n",
        });
      }
      const externalSourcePath = state.path(
        backslash ? "nix\\store" : "nix-store",
        kind === "config" ? "openclaw-default.json" : "credentials",
      );
      if (kind === "config") {
        await fs.mkdir(path.dirname(externalSourcePath), { recursive: true });
        if (volatile) {
          await fs.writeFile(externalSourcePath, "{}\n");
        } else {
          await fs.rename(sourcePath, externalSourcePath);
        }
      } else {
        await fs.mkdir(externalSourcePath, { recursive: true });
        await fs.writeFile(path.join(externalSourcePath, "credentials.json"), "managed\n");
      }
      let linkTarget = externalSourcePath;
      if (hops > 1) {
        const intermediatePath = state.path("nix-store", `${kind}-link`);
        await fs.symlink(externalSourcePath, intermediatePath);
        linkTarget = intermediatePath;
      }
      if (relative) {
        linkTarget = path.relative(path.dirname(sourcePath), linkTarget);
      }
      await fs.symlink(linkTarget, sourcePath);
      const canonicalExternalSourcePath = await fs.realpath(externalSourcePath);
      const sourceContentsPath =
        kind === "config" ? externalSourcePath : path.join(externalSourcePath, "credentials.json");
      const expectedContents = await fs.readFile(sourceContentsPath, "utf8");

      const result = await backupCreateCommand(createTestRuntime(), {
        output: outputPath,
        includeWorkspace: false,
        nowMs: Date.UTC(2026, 8, 2, 13, 0, 0),
      });
      const entries = await listArchiveEntryDetails(result.archivePath);
      const sourceArchiveSuffix = relativeArchivePath(state.stateDir, sourcePath);
      const archivedLink = expectDefined(
        entries.find((entry) => entry.path.endsWith(`/state/${sourceArchiveSuffix}`)),
        `archived ${kind} symlink`,
      );
      const managedAsset = expectDefined(
        result.assets.find(
          (asset) => asset.kind === kind && asset.sourcePath === canonicalExternalSourcePath,
        ),
        `declared ${kind} asset`,
      );

      expect(archivedLink).toMatchObject({ type: "SymbolicLink", linkpath: linkTarget });
      expect(result.externalSymbolicLinks).toContainEqual({
        entryPath: archivedLink.path,
        linkpath: linkTarget,
      });
      if (volatile) {
        expect(result.assets).toContainEqual(expect.objectContaining({ kind, sourcePath }));
        const neighborArchiveSuffix = relativeArchivePath(state.stateDir, path.dirname(sourcePath));
        expect(
          entries.some((entry) =>
            ["neighbor.json", "neighbor.tmp"].some((neighbor) =>
              entry.path.endsWith(`/state/${neighborArchiveSuffix}/${neighbor}`),
            ),
          ),
        ).toBe(false);
      }

      await expectVerifiedBackup(result);
      await restoreBackup(state, result);

      const restoredLinkPath = path.join(restorePath, archivedLink.path);
      const restoredAssetPath = path.join(restorePath, managedAsset.archivePath);
      expect(await fs.readlink(restoredLinkPath)).toBe(archivedLink.linkpath);
      const restoredContentsPath =
        kind === "config" ? restoredAssetPath : path.join(restoredAssetPath, "credentials.json");
      await expect(fs.readFile(restoredContentsPath, "utf8")).resolves.toBe(expectedContents);
    });
  },
);

it.each([
  { role: "global", privateTarget: false },
  { role: "agent", privateTarget: false },
  { role: "agent", privateTarget: true },
] as const)(
  "sanitizes canonical $role SQLite aliases (private=$privateTarget)",
  async ({ role, privateTarget }) => {
    if (process.platform === "win32") {
      return;
    }
    await withBackupState("openclaw-backup-core-alias-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const linkedDbPath = resolveCanonicalTestSqlitePath(state, role);
      const backingDir = privateTarget
        ? state.path("private-agent-db")
        : path.dirname(linkedDbPath);
      const backingDbPath = path.join(backingDir, `backing-${role}.sqlite`);
      const hardlinkedDbPath =
        role === "global"
          ? state.statePath("state/._hardlinked-global.sqlite")
          : state.statePath("plugins/dedicated/._agent-alias.sqlite");
      const durableValue = role === "global" ? "must-stay" : "committed-in-wal";
      const transientBlobMarker = `aliased-transient-blob-${"sensitive".repeat(32)}`;
      if (role === "global") {
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        });
      }
      await mkdirs(
        path.dirname(linkedDbPath),
        backingDir,
        path.dirname(hardlinkedDbPath),
        outputDir,
        extractDir,
      );
      if (privateTarget) {
        await fs.writeFile(
          path.join(backingDir, ".openclaw-private-update-capture"),
          "openclaw-private-update-capture-v1\n",
        );
      }
      createOwnedSqliteDatabase({
        sqlitePath: backingDbPath,
        role,
        agentId: role === "agent" ? "main" : undefined,
      });
      const db = new (requireNodeSqlite().DatabaseSync)(backingDbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE durable_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE delivery_queue_entries (id TEXT PRIMARY KEY);
        CREATE TABLE state_leases (scope TEXT NOT NULL, lease_key TEXT NOT NULL);
        CREATE TABLE plugin_blob_entries (
          plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
          metadata_json TEXT NOT NULL, blob BLOB NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        );
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO delivery_queue_entries VALUES ('keep');
        INSERT INTO state_leases VALUES ('core:test-fixture', 'write');
      `);
      db.prepare("INSERT INTO durable_state VALUES (1, ?)").run(durableValue);
      db.prepare("INSERT INTO plugin_blob_entries VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "diffs",
        "diff-artifacts",
        "transient",
        JSON.stringify({ marker: transientBlobMarker }),
        Buffer.from(transientBlobMarker),
        1,
        Date.UTC(2099, 0, 1),
      );
      if (role === "agent") {
        registerAgentDatabase(state, linkedDbPath);
      }
      await fs.symlink(backingDbPath, linkedDbPath);
      await fs.link(backingDbPath, hardlinkedDbPath);
      expect((await fs.stat(`${backingDbPath}-wal`)).size).toBeGreaterThan(0);
      await expectAbsent(`${linkedDbPath}-wal`);
      await expectAbsent(`${hardlinkedDbPath}-wal`);

      try {
        const create = () =>
          role === "agent"
            ? createVerifiedBackup(state, { output: outputDir })
            : createBackupArchive({
                output: outputDir,
                includeWorkspace: true,
                nowMs: Date.UTC(2026, 4, 9, 8, 34, 30),
              });
        if (privateTarget) {
          await expect(create()).rejects.toThrow(
            "Private update captures are excluded from backups and support exports.",
          );
          expect(await fs.readdir(outputDir)).toEqual([]);
          expectRow(db, "SELECT value FROM durable_state WHERE id = 1", { value: durableValue });
          return;
        }
        const result = await create();
        const suffixes = [linkedDbPath, backingDbPath, hardlinkedDbPath].map(
          (source) => `/state/${relativeArchivePath(state.stateDir, source)}`,
        );
        const entries = (await listArchiveEntryDetails(result.archivePath)).filter((entry) =>
          suffixes.some((suffix) => entry.path.endsWith(suffix)),
        );
        expect(entries.map((entry) => entry.type)).toEqual(["File", "File", "File"]);
        await extractBackup(result, extractDir);
        for (const entry of entries) {
          const archivedPath = path.join(extractDir, entry.path);
          if (role === "global") {
            expect((await fs.readFile(archivedPath)).includes(transientBlobMarker)).toBe(false);
          }
          inspectDatabase(archivedPath, (archivedDb) => {
            if (role === "global") {
              expectRow(archivedDb, "PRAGMA integrity_check", { integrity_check: "ok" });
            }
            expectRow(archivedDb, "SELECT value FROM durable_state WHERE id = 1", {
              value: durableValue,
            });
            expectRow(archivedDb, "SELECT COUNT(*) AS count FROM state_leases", { count: 0 });
            for (const table of ["delivery_queue_entries", "plugin_blob_entries"]) {
              expectRow(archivedDb, `SELECT COUNT(*) AS count FROM ${table}`, {
                count: role === "global" ? 0 : 1,
              });
            }
          });
        }
        if (role === "agent") {
          expectRow(db, "SELECT COUNT(*) AS count FROM state_leases", { count: 1 });
        }
        await expectVerifiedBackup(result);
      } finally {
        db.close();
        if (role === "agent") {
          await fs.rm(hardlinkedDbPath, { force: true });
        }
      }
    });
  },
);

it("omits reinstallable runtime trees and plugin dependencies while keeping plugin files", async () => {
  await withBackupState("openclaw-backup-plugin-deps-", async (state) => {
    const outputDir = state.path("backups");
    const durablePaths = [
      "developer",
      "dev-backup",
      "temporary",
      "tmp-data",
      "agents/main/agent/runtime-home/sessions",
      "agents/main/agent/runtime-home/tmp-data",
      "agents/main/agent/runtime-home/.tmp-data",
      "agents/main/agent/runtime-home/temporary",
      "agents/main/not-agent/tmp",
    ];
    for (const relativePath of [
      "extensions/demo/src/index.js",
      "extensions/demo/node_modules/dep/index.js",
      "extensions/demo/node_modules/dep/cache.sqlite",
      "node_modules/root-dep/index.js",
      "node_modules/root-dep/fixture.sqlite",
      "npm/projects/demo/node_modules/dep/fixture.sqlite",
      "dev/openclaw/.git/objects/pack/pack-fixture.pack",
      "dev/openclaw/node_modules/dep/index.js",
      "dev/openclaw/dist/entry.js",
      "dev/openclaw/invalid.sqlite",
      ...durablePaths.map((durablePath) => `${durablePath}/keep.txt`),
      ...["dev", "git", "npm-runtime", "tmp", "tools"].map(
        (root) => `${root}/runtime/fixture.sqlite`,
      ),
    ]) {
      await state.writeText(relativePath, "synthetic runtime fixture\n");
    }
    await state.writeText("extensions/demo/openclaw.plugin.json", '{"id":"demo"}\n');
    await fs.mkdir(outputDir, { recursive: true });

    const result = await createStateArchive(outputDir);
    const entries = await listArchiveEntries(result.archivePath);

    const entrySuffixes = entries.map((entry) => entry.replace(/^.*\/state\//, "/state/"));
    expect(entrySuffixes).toContain("/state/extensions/demo/openclaw.plugin.json");
    expect(entrySuffixes).toContain("/state/extensions/demo/src/index.js");
    expect(entrySuffixes).toContain("/state/node_modules/root-dep/index.js");
    expect(entrySuffixes).toContain("/state/node_modules/root-dep/fixture.sqlite");
    for (const managedRoot of ["dev", "git", "npm", "npm-runtime", "tmp", "tools"]) {
      expect(
        entrySuffixes.some(
          (entry) =>
            entry === `/state/${managedRoot}` || entry.startsWith(`/state/${managedRoot}/`),
        ),
        managedRoot,
      ).toBe(false);
    }
    for (const durablePath of durablePaths) {
      expect(entrySuffixes).toContain(`/state/${durablePath}/keep.txt`);
    }
    const pluginNodeModuleEntries = entries.filter((entry) =>
      entry.includes("/state/extensions/demo/node_modules/"),
    );
    expect(pluginNodeModuleEntries).toStrictEqual([]);

    await expectVerifiedBackup(result);
  });
});

it("preserves configured state paths nested under managed runtime roots", async () => {
  await withBackupFixture(
    { prefix: "openclaw-backup-managed-root-workspace-", env: { OPENCLAW_OAUTH_DIR: undefined } },
    async (state) => {
      const stateDir = state.stateDir;
      const workspaceDir = path.join(stateDir, "dev/workspace");
      const tmpWorkspaceDir = path.join(stateDir, "tmp/workspace");
      const agentTempRoot = state.statePath("agents/main/agent/runtime-home/.tmp");
      const agentTmpWorkspaceDir = path.join(agentTempRoot, "workspace");
      const externalTmpWorkspaceDir = state.path("tmp");
      const configPath = path.join(stateDir, "git/config/openclaw.json");
      const oauthDir = path.join(stateDir, "tools/oauth");
      const workspaceDbPath = path.join(workspaceDir, "workspace.sqlite");
      const outputDir = state.path("backups");
      state.envVars.OPENCLAW_CONFIG_PATH = configPath;
      state.envVars.OPENCLAW_OAUTH_DIR = oauthDir;
      state.applyEnv();
      await writeFiles(stateDir, {
        "tools/oauth/credentials.json": "{}\n",
        "dev/workspace/AGENTS.md": "durable workspace\n",
        "tmp/workspace/AGENTS.md": "durable tmp workspace\n",
        "agents/main/agent/runtime-home/.tmp/workspace/AGENTS.md": "durable agent tmp workspace\n",
        "agents/main/agent/runtime-home/.tmp/scratch/cache-entry": "scratch\n",
        "tmp/tsx-501/cache-entry": "rebuildable compiler cache\n",
        "dev/openclaw/package.json": "{}\n",
        "tools/runtime/tool.bin": "runtime\n",
      });
      await writeFiles(externalTmpWorkspaceDir, {
        "AGENTS.md": "durable external tmp workspace\n",
      });
      await state.writeJson("git/config/openclaw.json", {
        agents: {
          defaults: { systemAgent: { agentId: "main" } },
          entries: {
            main: { workspace: workspaceDir },
            external: { workspace: externalTmpWorkspaceDir },
            worker: { workspace: tmpWorkspaceDir },
            nested: { workspace: agentTmpWorkspaceDir },
          },
        },
      });
      if (process.platform !== "win32") {
        await fs.symlink(
          path.relative(stateDir, path.join(externalTmpWorkspaceDir, "AGENTS.md")),
          path.join(stateDir, "external-workspace-link"),
        );
      }
      withDatabase(workspaceDbPath, (workspaceDb) => {
        workspaceDb.exec(
          "CREATE TABLE durable_state (value TEXT NOT NULL); INSERT INTO durable_state VALUES ('keep');",
        );
      });
      await fs.mkdir(outputDir, { recursive: true });

      const result = await createBackupArchive({
        output: outputDir,
        includeWorkspace: true,
        nowMs: Date.UTC(2026, 3, 28, 12, 30, 0),
      });
      const entries = await listArchiveEntries(result.archivePath);

      expectArchivePath(entries, "/state/dev/workspace/AGENTS.md", true);
      expectArchivePath(entries, "/state/dev/workspace/workspace.sqlite", true);
      expectArchivePath(entries, "/state/tmp/workspace/AGENTS.md", true);
      expectArchivePath(
        entries,
        "/state/agents/main/agent/runtime-home/.tmp/workspace/AGENTS.md",
        true,
      );
      expectArchivePath(entries, "/tmp/AGENTS.md", true);
      if (process.platform !== "win32") {
        expectArchivePath(entries, "/state/external-workspace-link", true);
      }
      expectArchivePath(entries, "/state/git/config/openclaw.json", true);
      expectArchivePath(entries, "/state/tools/oauth/credentials.json", true);
      expect(entries.some((entry) => entry.includes("/state/dev/openclaw/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/state/tmp/tsx-501/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/state/tools/runtime/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/runtime-home/.tmp/scratch/"))).toBe(false);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          kind: "agent temporary files",
          sourcePath: agentTempRoot,
          reason: "regenerable",
        }),
      );

      await expectVerifiedBackup(result);
    },
  );
});

it("keeps one manifest when the tempdir is equal to state", async () => {
  await withBackupState("openclaw-backup-tmp-equals-state-", async (state) => {
    const { dbPath: emptyDbPath, outputDir, extractDir } = await pluginPaths(state, "empty.sqlite");
    await fs.writeFile(emptyDbPath, "");
    vi.spyOn(os, "tmpdir").mockReturnValue(state.stateDir);

    const result = await createStateArchive(outputDir);
    const entries = await listArchiveEntries(result.archivePath);
    const rootManifestEntries = entries.filter(
      (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
    );
    expect(rootManifestEntries).toHaveLength(1);
    const emptyDbEntries = entries.filter((entry) =>
      entry.endsWith("/state/plugins/dedicated/empty.sqlite"),
    );
    expect(emptyDbEntries).toHaveLength(1);
    expect(entries.some((entry) => entry.includes("/openclaw-state-db-"))).toBe(false);

    await extractBackup(result, extractDir);
    inspectDatabase(
      path.join(extractDir, expectDefined(emptyDbEntries[0], "empty database")),
      (archivedDb) => expectRow(archivedDb, "PRAGMA integrity_check", { integrity_check: "ok" }),
    );

    await expectVerifiedBackup(result);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
