import { execFileSync } from "node:child_process";
import fsSync, { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { formatBackupCreateSummary } from "../commands/backup-summary.js";
import { backupVerifyCommand, verifyBackupArchive } from "../commands/backup-verify.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import * as backupRunRecords from "../state/backup-run-records.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createBackupArchive, type BackupCreateResult } from "./backup-create.js";
import {
  createBackupClassificationInventory,
  listArchiveEntries,
  listArchiveEntryDetails,
  makeBackupResult,
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
  return withOpenClawTestState({ layout: "state-only", scenario: "minimal", prefix }, fn);
}

function createStateArchive(output: string): Promise<BackupCreateResult> {
  return createBackupArchive({
    output,
    includeWorkspace: false,
    nowMs: Date.UTC(2026, 4, 9, 12),
  });
}

function expectArchivePath(entries: string[], suffix: string, present: boolean): void {
  expect(
    entries.some((entry) => entry.endsWith(suffix)),
    suffix,
  ).toBe(present);
}

const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function withBackupClassificationDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-classify-"));
  try {
    await run(await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = Number(
      Object.values(database.prepare("PRAGMA schema_version;").get() as Record<string, unknown>)[0],
    );
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createEmptySqliteDatabase(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec("VACUUM;");
  } finally {
    database.close();
  }
}

function createOwnedSqliteDatabase(params: {
  sqlitePath: string;
  role: "agent" | "global";
  agentId?: string;
  schemaVersion?: number;
}): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(params.sqlitePath);
  const schemaVersion = params.schemaVersion ?? 1;
  try {
    database.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${schemaVersion};
    `);
    database
      .prepare(
        `INSERT INTO schema_meta
          (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
         VALUES ('primary', ?, ?, ?, NULL, 1, 1)`,
      )
      .run(params.role, schemaVersion, params.agentId ?? null);
  } finally {
    database.close();
  }
}

async function declarePluginSqliteResources(state: OpenClawTestState): Promise<void> {
  const rootDir = state.path("synthetic-backup-plugin");
  await fs.mkdir(rootDir, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId: "backup-owner",
    manifest: {
      backupResources: [
        { disposition: "include", scope: "state", relativePath: "plugins/dedicated" },
      ],
    },
  });
  await state.writeConfig(createColdPluginConfig(rootDir, fixture.pluginId));
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
    : state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
}

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeBackupResult({
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
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Skipped 3 volatile files (live sessions, cron logs, queues, managed runtime paths, sockets, pid/tmp).",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeBackupResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });
});

describe("writeTarArchiveWithRetry", () => {
  const eof = Object.assign(new Error("encountered unexpected EOF"), {
    code: "EOF",
    path: "/state/logs/gateway.jsonl",
  });
  it.each([
    {
      name: "message-only EOF",
      errors: [new Error("unexpected eof while reading")],
      attempts: 1,
      failure: /after 1 attempt\)/,
      backoffs: [],
    },
    {
      name: "non-Error rejection",
      errors: ["did not encounter expected EOF"],
      attempts: 1,
      failure: /after 1 attempt\)/,
      backoffs: [],
    },
    {
      name: "missing error",
      errors: [undefined],
      attempts: 1,
      failure: /after 1 attempt\)/,
      backoffs: [],
    },
    {
      name: "later non-EOF failure",
      errors: [eof, new Error("permission denied")],
      attempts: 2,
      failure: /permission denied.*after 2 attempts\)/,
      backoffs: [10_000],
    },
    {
      name: "successful retries",
      errors: [Object.assign(new Error("encountered unexpected EOF"), { code: "EOF" }), eof],
      attempts: 3,
      failure: undefined,
      backoffs: [10_000, 20_000],
    },
    {
      name: "exhausted retries",
      errors: [eof, eof, eof],
      attempts: 3,
      failure: /last offending path: \/state\/logs\/gateway\.jsonl, after 3 attempts/,
      backoffs: [10_000, 20_000],
    },
  ])("preserves retry ownership for $name", async ({ errors, attempts, failure, backoffs }) => {
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
      expect(runTar).toHaveBeenNthCalledWith(1, tempArchivePath);
      if (attempts > 1) {
        expect(runTar).toHaveBeenNthCalledWith(2, `${tempArchivePath}.retry-2`);
      }
      if (attempts > 2) {
        expect(runTar).toHaveBeenNthCalledWith(3, `${tempArchivePath}.retry-3`);
      }
      expect(sleep.mock.calls).toEqual(backoffs.map((ms) => [ms]));
      expect(log).toHaveBeenCalledTimes(failure ? 0 : backoffs.length);
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });
});

describe("volatile archive traversal", () => {
  it("filters a volatile file removed after directory discovery", async () => {
    await withBackupState("openclaw-backup-volatile-traversal-", async (state) => {
      const volatilePath = await state.writeText("logs/gateway.log", "live log\n");
      await state.writeText("settings.json", '{"keep":true}\n');
      const readdir = fs.readdir;
      const walk = backupTarWalk.walkBackupTar;
      let archiving = false;
      let removedBeforeStat = false;
      const traversal = vi.spyOn(backupTarWalk, "walkBackupTar").mockImplementation((params) => {
        archiving = true;
        return walk(params);
      });
      const discovery = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const entries = await readdir(...args);
        // Earlier discovery also lists logs; remove only after the payload walker lists its name.
        if (archiving && args[0] === path.dirname(volatilePath)) {
          rmSync(volatilePath, { force: true });
          removedBeforeStat = true;
        }
        return entries;
      });
      try {
        const archive = await createStateArchive(state.path("backup.tar.gz"));
        const entries = await listArchiveEntries(archive.archivePath);
        expect(removedBeforeStat).toBe(true);
        expect(archive.skippedVolatileCount).toBe(1);
        expectArchivePath(entries, "/settings.json", true);
        expectArchivePath(entries, "/logs/gateway.log", false);
      } finally {
        discovery.mockRestore();
        traversal.mockRestore();
      }
    });
  });
});

describe("backup SQLite AppleDouble classification", () => {
  it.each(["directory", "symlink"])("does not open matching %s metadata", async (kind) => {
    await withBackupClassificationDir(async (dir) => {
      const filePath = path.join(dir, "._example.sqlite");
      if (kind === "directory") {
        await fs.mkdir(filePath);
      } else {
        const target = path.join(dir, "._target.sqlite");
        await fs.writeFile(target, APPLE_DOUBLE_MAGIC);
        await fs.symlink(target, filePath);
      }
      expect(classifyBackupSqliteSource(filePath, createBackupClassificationInventory(dir))).toBe(
        "sqlite",
      );
    });
  });

  it.skipIf(process.platform === "win32")("does not open a matching FIFO", async () => {
    await withBackupClassificationDir(async (dir) => {
      const filePath = path.join(dir, "._pipe.sqlite");
      execFileSync("mkfifo", [filePath]);
      expect(classifyBackupSqliteSource(filePath, createBackupClassificationInventory(dir))).toBe(
        "sqlite",
      );
    });
  });

  it("does not follow a symlink substituted immediately before open", async () => {
    await withBackupClassificationDir(async (dir) => {
      const filePath = path.join(dir, "._race.sqlite");
      const target = path.join(dir, "target");
      await fs.writeFile(filePath, "ordinary content");
      await fs.writeFile(target, APPLE_DOUBLE_MAGIC);
      const open = fsSync.openSync;
      let replaced = false;
      const spy = vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
        if (pathname === filePath) {
          fsSync.unlinkSync(filePath);
          fsSync.symlinkSync(target, filePath);
          replaced = true;
        }
        return open(pathname, flags, mode);
      });
      try {
        expect(classifyBackupSqliteSource(filePath, createBackupClassificationInventory(dir))).toBe(
          "sqlite",
        );
        expect(replaced).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it.each(["outside", "package", "excluded"])("preserves %s inventory admission", async (kind) => {
    await withBackupClassificationDir(async (dir) => {
      const filePath = path.join(dir, "._cron.sqlite");
      await fs.writeFile(filePath, APPLE_DOUBLE_MAGIC);
      const inventory = {
        ...createBackupClassificationInventory(kind === "outside" ? path.join(dir, "state") : dir),
        isPackageContent: () => kind === "package",
        isIncluded: () => kind !== "excluded",
      };
      const open = vi.spyOn(fsSync, "openSync");
      try {
        expect(classifyBackupSqliteSource(filePath, inventory)).toBe(
          kind === "excluded" ? "excluded" : undefined,
        );
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    });
  });

  it.each(["signature", "short", "read failure", "open validation failure"])(
    "closes the probe descriptor after %s",
    async (outcome) => {
      await withBackupClassificationDir(async (dir) => {
        const filePath = path.join(dir, "._cron.sqlite");
        await fs.writeFile(
          filePath,
          outcome === "short" ? APPLE_DOUBLE_MAGIC.subarray(0, 2) : APPLE_DOUBLE_MAGIC,
        );
        const open = fsSync.openSync;
        let descriptor: number | undefined;
        const openSpy = vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
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
          expect(
            classifyBackupSqliteSource(filePath, createBackupClassificationInventory(dir)),
          ).toBe(outcome === "signature" ? "excluded" : "sqlite");
        } finally {
          openSpy.mockRestore();
          failureSpy?.mockRestore();
        }
        expect(() =>
          fsSync.fstatSync(expectDefined(descriptor, "metadata probe descriptor")),
        ).toThrow(expect.objectContaining({ code: "EBADF" }));
      });
    },
  );
});

describe("createBackupArchive", () => {
  it("excludes AppleDouble metadata only from SQLite-owned roots", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      });
      const metadata = Buffer.alloc(163);
      APPLE_DOUBLE_MAGIC.copy(metadata);
      await fs.writeFile(state.statePath("._cron.sqlite"), metadata);
      await fs.writeFile(path.join(state.workspaceDir, "._workspace.sqlite"), metadata);
      await fs.mkdir(state.statePath("._directory.sqlite"));
      await fs.writeFile(state.statePath("._directory.sqlite", "keep.txt"), "keep");
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
      const runtime = createTestRuntime();
      await expect(
        backupVerifyCommand(runtime, { archive: result.archivePath }),
      ).resolves.toMatchObject({ ok: true });
    });
  });
  it.each<{
    configRelativePath: string;
    onlyConfig: boolean;
    malformed: boolean;
    volatileParent?: boolean;
    absoluteNeighbor?: boolean;
  }>([
    { configRelativePath: "openclaw.json.tmp", onlyConfig: false, malformed: false },
    {
      configRelativePath: "sandbox/skills-workspaces/operator/openclaw.json",
      onlyConfig: false,
      malformed: false,
      volatileParent: true,
    },
    { configRelativePath: "openclaw.json.tmp", onlyConfig: true, malformed: true },
    {
      configRelativePath: "cache.tmp/ordinary/openclaw.json",
      onlyConfig: false,
      malformed: false,
      volatileParent: true,
    },
    {
      configRelativePath: "cache.tmp/linked/openclaw.json",
      onlyConfig: false,
      malformed: false,
      volatileParent: true,
      absoluteNeighbor: true,
    },
    {
      configRelativePath: "logs/history.log/openclaw.json",
      onlyConfig: false,
      malformed: false,
      volatileParent: true,
    },
  ])(
    "archives active config bytes at $configRelativePath (onlyConfig=$onlyConfig, malformed=$malformed)",
    async ({ configRelativePath, onlyConfig, malformed, volatileParent, absoluteNeighbor }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-active-config-" },
        async (state) => {
          const configPath = state.statePath(...configRelativePath.split("/"));
          const configRaw = malformed ? '{"gateway":' : '{"gateway":{"mode":"local"}}\n';
          state.envVars.OPENCLAW_CONFIG_PATH = configPath;
          state.applyEnv();
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, configRaw);
          await state.writeText("logs/live.log", "live log\n");
          await state.writeText("scratch.tmp", "temporary state\n");
          await state.writeText(
            "sandbox/skills-workspaces/other/generated.json",
            "generated state\n",
          );
          await fs.writeFile(path.join(path.dirname(configPath), "neighbor.tmp"), "temporary\n");
          await fs.writeFile(path.join(path.dirname(configPath), "neighbor.json"), "{}\n");
          if (absoluteNeighbor && process.platform !== "win32") {
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
          await fs.mkdir(extractDir);
          await tar.x({ file: archive.archivePath, gzip: true, cwd: extractDir });
          const configEntry = expectDefined(configEntries[0], "active config archive entry");
          expect(await fs.readFile(path.join(extractDir, configEntry), "utf8")).toBe(configRaw);
          await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
            ok: true,
          });
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    {
      layout: "direct",
      linkSegments: ["demo"],
      linkTargetSegments: ["demo"],
      skillSegments: ["demo"],
    },
    {
      layout: "grouped",
      linkSegments: ["team", "demo"],
      linkTargetSegments: ["demo"],
      skillSegments: ["demo"],
    },
    {
      layout: "group link",
      linkSegments: ["team"],
      linkTargetSegments: ["team.tmp"],
      skillSegments: ["team.tmp", "demo"],
    },
  ])(
    "archives a $layout external managed-skill target and verifies its payload",
    async ({ linkSegments, linkTargetSegments, skillSegments }) => {
      await withBackupState("openclaw-backup-skill-symlink-", async (state) => {
        const externalRoot = path.join(await fs.realpath(state.root), "agents-skills");
        const skillTarget = path.join(externalRoot, ...skillSegments);
        await fs.mkdir(skillTarget, { recursive: true });
        await fs.writeFile(
          path.join(skillTarget, "SKILL.md"),
          "---\nname: demo\ndescription: Symlinked managed skill\n---\n",
          "utf8",
        );
        await fs.writeFile(path.join(skillTarget, "operator-data.txt"), "keep me\n", "utf8");
        const linkPath = state.statePath("skills", ...linkSegments);
        const linkTarget = path.join(externalRoot, ...linkTargetSegments);
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        // Operator-managed roots support relative directory links outside the state root.
        await fs.symlink(path.relative(path.dirname(linkPath), linkTarget), linkPath, "dir");

        const archive = await createStateArchive(state.path("backup.tar.gz"));
        const entries = await listArchiveEntries(archive.archivePath);
        const skillSuffix = path.posix.join("/agents-skills", ...skillSegments, "SKILL.md");
        expect(entries.some((entry) => entry.endsWith(skillSuffix))).toBe(true);
        expect(
          entries.some((entry) =>
            entry.endsWith(
              path.posix.join("/agents-skills", ...skillSegments, "operator-data.txt"),
            ),
          ),
        ).toBe(true);

        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
          ok: true,
        });
      });
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
        const link = state.statePath("skills", "broad");
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(path.relative(path.dirname(link), target), link, "dir");
        const result = await backupCreateCommand(createTestRuntime(), {
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
          verify: true,
        });
        const entries = await listArchiveEntryDetails(result.archivePath);
        expect(result.assets.some((asset) => asset.kind === "managed skill")).toBe(false);
        expect(entries.some((entry) => entry.path.endsWith("/SKILL.md"))).toBe(false);
        expect(entries.filter((entry) => entry.type === "SymbolicLink")).toHaveLength(1);
        expect(result.externalSymbolicLinks).toHaveLength(1);
      });
    },
  );

  it.each(["sole agent", "explicit roster"])(
    "omits a nested workspace absolute symlink without dropping a nested agent root for %s",
    async (roster) => {
      if (process.platform === "win32") {
        return;
      }

      await withBackupState("openclaw-backup-nested-workspace-symlink-", async (state) => {
        const nestedWorkspace = state.statePath("workspace");
        const agentDir = path.join(nestedWorkspace, "custom-agent");
        const outsideTarget = state.path("outside-build");
        await fs.mkdir(nestedWorkspace, { recursive: true });
        await fs.mkdir(agentDir, { recursive: true });
        await fs.mkdir(outsideTarget, { recursive: true });
        await fs.writeFile(path.join(nestedWorkspace, "notes.md"), "workspace notes\n", "utf8");
        await fs.writeFile(path.join(agentDir, "durable-agent-state.json"), "{}\n", "utf8");
        await fs.symlink(outsideTarget, path.join(nestedWorkspace, ".build"), "dir");
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: { workspace: nestedWorkspace },
            entries: {
              main: { agentDir },
              ...(roster === "explicit roster"
                ? { helper: { workspace: state.path("helper-workspace") } }
                : {}),
            },
          },
        });

        const archive = await createStateArchive(state.path("backup.tar.gz"));
        const entries = await listArchiveEntries(archive.archivePath);

        expect(archive.assets.map((asset) => asset.kind)).not.toContain("workspace");
        expect(entries.some((entry) => entry.includes("/workspace/.build"))).toBe(false);
        expectArchivePath(entries, "/workspace/notes.md", false);
        expectArchivePath(entries, "/custom-agent/durable-agent-state.json", true);
        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({
          ok: true,
        });
      });
    },
  );

  it("omits an absolute workspace-root symlink under the state directory", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBackupState("openclaw-backup-workspace-root-symlink-", async (state) => {
      const realWorkspace = state.path("real-workspace");
      const lexicalWorkspace = state.statePath("workspace");
      await fs.mkdir(realWorkspace, { recursive: true });
      await fs.writeFile(path.join(realWorkspace, "notes.md"), "workspace notes\n", "utf8");
      await fs.symlink(realWorkspace, lexicalWorkspace, "dir");
      await state.writeConfig({
        agents: {
          defaults: { workspace: lexicalWorkspace },
        },
      });

      const archive = await createStateArchive(state.path("backup.tar.gz"));
      const entries = await listArchiveEntries(archive.archivePath);

      expect(archive.assets.map((asset) => asset.kind)).not.toContain("workspace");
      expect(entries.some((entry) => entry.includes("/workspace"))).toBe(false);
      expectArchivePath(entries, "/notes.md", false);
    });
  });

  it.each([
    ["the state directory", (state: OpenClawTestState) => state.stateDir],
    ["a parent of the state directory", (state: OpenClawTestState) => path.dirname(state.stateDir)],
  ] as const)(
    "keeps ordinary state files when the excluded workspace is %s",
    async (_label, resolveWorkspace) => {
      await withBackupState("openclaw-backup-workspace-contains-state-", async (state) => {
        const sentinel = state.statePath("sentinel-state.json");
        const nestedStateDir = state.statePath("workspace");
        const nestedState = path.join(nestedStateDir, "durable-state.json");
        await fs.mkdir(nestedStateDir, { recursive: true });
        await fs.writeFile(sentinel, '{"ok":true}\n', "utf8");
        await fs.writeFile(nestedState, '{"nested":true}\n', "utf8");
        await state.writeConfig({
          agents: {
            defaults: { workspace: resolveWorkspace(state) },
          },
        });

        const archive = await createStateArchive(state.path("backup.tar.gz"));
        const entries = await listArchiveEntries(archive.archivePath);

        expect(archive.assets.map((asset) => asset.kind)).not.toContain("workspace");
        expectArchivePath(entries, "/sentinel-state.json", true);
        expectArchivePath(entries, "/workspace/durable-state.json", true);
      });
    },
  );

  it.each([
    { name: "external agent asset", placement: "external", includeWorkspace: false },
    { name: "agent covered by a workspace", placement: "workspace", includeWorkspace: true },
    { name: "agent under a managed state root", placement: "managed", includeWorkspace: false },
    {
      name: "custom agent nested in the default agent layout",
      placement: "default-layout",
      includeWorkspace: false,
    },
  ] as const)(
    "safely snapshots, verifies, and restores a configured $name",
    async ({ placement, includeWorkspace }) => {
      await withBackupState("openclaw-backup-owned-agent-sqlite-", async (state) => {
        const agentDir =
          placement === "workspace"
            ? path.join(state.workspaceDir, "custom-agent")
            : placement === "managed"
              ? state.statePath("tmp", "custom-agent")
              : placement === "default-layout"
                ? state.statePath("agents", "main", "agent", "custom-agent")
                : state.path("custom-agent");
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
        await state.writeConfig({
          agents: {
            entries: {
              main: {
                agentDir,
                ...(includeWorkspace ? { workspace: state.workspaceDir } : {}),
              },
            },
          },
        });
        for (const dirname of durableAgentDirectories) {
          await fs.mkdir(path.join(agentDir, dirname), { recursive: true });
          await fs.writeFile(path.join(agentDir, dirname, "durable.txt"), "keep\n", "utf8");
        }
        createOwnedSqliteDatabase({ sqlitePath: dbPath, role: "agent", agentId: "main" });
        registerAgentDatabase(state, dbPath);

        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        const deletedMarker = "EXTERNAL_AGENT_DELETED_SECRET_84b5f1";
        let archive: BackupCreateResult;
        const lstatSpy = vi.spyOn(fs, "lstat");
        try {
          db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            PRAGMA secure_delete = OFF;
            CREATE TABLE durable_records (value TEXT NOT NULL);
          `);
          db.prepare("INSERT INTO durable_records (value) VALUES (?)").run(
            `${deletedMarker}-${"x".repeat(16_384)}`,
          );
          db.prepare("INSERT INTO durable_records (value) VALUES (?)").run("checkpointed");
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          db.prepare("DELETE FROM durable_records WHERE value LIKE ?").run(`${deletedMarker}%`);
          db.prepare("INSERT INTO durable_records (value) VALUES (?)").run("committed-in-wal");
          expect((await fs.readFile(dbPath)).includes(Buffer.from(deletedMarker))).toBe(true);
          await fs.access(`${dbPath}-wal`);
          await fs.access(`${dbPath}-shm`);

          archive = await createBackupArchive({
            output: state.path("owned-agent.tar.gz"),
            includeWorkspace,
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
        if (placement === "external") {
          expect(archive.assets).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ kind: "agent", sourcePath: agentDir }),
            ]),
          );
        }
        const archivedDbEntry = expectDefined(
          entries.find((entry) => entry.endsWith("/custom-agent/openclaw-agent.sqlite")),
          "configured agent database snapshot",
        );
        expectArchivePath(entries, "/openclaw-agent.sqlite-wal", false);
        expectArchivePath(entries, "/openclaw-agent.sqlite-shm", false);
        for (const dirname of durableAgentDirectories) {
          expectArchivePath(entries, `/custom-agent/${dirname}/durable.txt`, true);
        }

        const runtime = createTestRuntime();
        const restore = await backupRestoreCommand(runtime, {
          archive: archive.archivePath,
          target: state.path("restored"),
        });
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
        expect((await fs.readFile(restoredDbPath)).includes(Buffer.from(deletedMarker))).toBe(
          false,
        );
        const restoredDb = new sqlite.DatabaseSync(restoredDbPath, { readOnly: true });
        try {
          expect(
            restoredDb.prepare("SELECT value FROM durable_records ORDER BY value").all(),
          ).toEqual([{ value: "checkpointed" }, { value: "committed-in-wal" }]);
        } finally {
          restoredDb.close();
        }
      });
    },
  );

  it("applies activated manifest-owned exclusions before SQLite and symlink handling", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-resource-",
        scenario: "minimal",
      },
      async (state) => {
        const agentDir = state.path("external-agent");
        const pluginRoot = state.path("synthetic-backup-plugin");
        const excludedStateRoot = state.statePath("generated");
        const excludedAgentRoot = path.join(agentDir, "codex-home", "tmp", "arg0");
        await fs.mkdir(pluginRoot, { recursive: true });
        await fs.mkdir(path.join(excludedStateRoot, "protected"), { recursive: true });
        await fs.mkdir(path.join(excludedAgentRoot, "protected"), { recursive: true });
        await fs.mkdir(path.join(agentDir, "codex-home", "tmp", "arg0-data"), {
          recursive: true,
        });
        await fs.mkdir(path.join(agentDir, "codex-home", ".tmp-data"), { recursive: true });
        createColdPluginFixture({
          rootDir: pluginRoot,
          pluginId: "backup-owner",
          manifest: {
            backupResources: [
              { disposition: "regenerable", scope: "state", relativePath: "generated" },
              { disposition: "include", scope: "state", relativePath: "generated/protected" },
              {
                disposition: "regenerable",
                scope: "state",
                relativePath: "state/openclaw.sqlite",
              },
              {
                disposition: "regenerable",
                scope: "agent",
                relativePath: "openclaw-agent.sqlite",
              },
              {
                disposition: "regenerable",
                scope: "agent",
                relativePath: "codex-home/tmp/arg0",
              },
              {
                disposition: "include",
                scope: "agent",
                relativePath: "codex-home/tmp/arg0/protected",
              },
            ],
          },
        });
        await fs.writeFile(path.join(excludedStateRoot, "unsafe.sqlite"), "not sqlite\n", "utf8");
        await fs.writeFile(path.join(excludedStateRoot, "protected", "keep.txt"), "keep\n", "utf8");
        await fs.writeFile(path.join(excludedAgentRoot, "unsafe.sqlite"), "not sqlite\n", "utf8");
        await fs.writeFile(path.join(excludedAgentRoot, "protected", "keep.txt"), "keep\n", "utf8");
        await fs.writeFile(
          path.join(agentDir, "codex-home", "tmp", "arg0-data", "keep.txt"),
          "keep\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(agentDir, "codex-home", ".tmp-data", "keep.txt"),
          "keep\n",
          "utf8",
        );
        if (process.platform !== "win32") {
          await fs.symlink("/outside-backup", path.join(excludedAgentRoot, "unsafe-link"));
        }
        await state.writeConfig({
          agents: { entries: { main: { agentDir } } },
          plugins: {
            load: { paths: [pluginRoot] },
            entries: { "backup-owner": { enabled: true } },
          },
        });
        const globalDbPath = resolveCanonicalTestSqlitePath(state, "global");
        const agentDbPath = path.join(agentDir, "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(globalDbPath), { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: agentDbPath,
          role: "agent",
          agentId: "main",
        });
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
          expect(
            entries.some((entry) => entry.endsWith(suffix)),
            suffix,
          ).toBe(true);
        }
        expectArchivePath(entries, "/unsafe.sqlite", false);
        expectArchivePath(entries, "/unsafe-link", false);
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ sourcePath: excludedAgentRoot, reason: "regenerable" }),
        );
      },
    );
  });

  it("keeps ACPX codex-home scratch symlinks out of the archive via the real acpx manifest", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
    await withBackupState("openclaw-backup-acpx-regenerable-", async (state) => {
      const acpxRoot = state.statePath("acpx");
      const codexHome = path.join(acpxRoot, "codex-home");
      const arg0Root = path.join(codexHome, "tmp", "arg0");
      const arg0Session = path.join(arg0Root, "codex-arg0-session");
      await fs.mkdir(arg0Session, { recursive: true });
      await fs.mkdir(path.join(codexHome, ".tmp", "plugins"), { recursive: true });
      await fs.writeFile(path.join(codexHome, ".tmp", "plugins", "README.md"), "cache\n");
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        "# isolated codex home config\n",
        "utf8",
      );
      await fs.writeFile(path.join(codexHome, "user-state.txt"), "keep\n", "utf8");
      await fs.writeFile(
        path.join(acpxRoot, "codex-acp-wrapper.mjs"),
        "// wrapper script\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(arg0Session, "apply_patch"),
        "placeholder when symlinks are unsupported\n",
        "utf8",
      );
      if (process.platform !== "win32") {
        // Codex creates argv0 aliases as absolute links to its installed binary.
        await fs.rm(path.join(arg0Session, "apply_patch"));
        await fs.symlink("/opt/codex/bin/codex", path.join(arg0Session, "apply_patch"));
      }
      await state.writeConfig({
        plugins: {
          load: { paths: [path.resolve("extensions/acpx")] },
          entries: { acpx: { enabled: true } },
        },
      });

      const result = await createStateArchive(state.path("acpx-backup.tar.gz"));
      const entries = await listArchiveEntries(result.archivePath);

      // Adjacent ACPX state stays in the archive.
      expectArchivePath(entries, "/state/acpx/codex-home/config.toml", true);
      expectArchivePath(entries, "/state/acpx/codex-home/user-state.txt", true);
      expectArchivePath(entries, "/state/acpx/codex-acp-wrapper.mjs", true);
      // Regenerable codex-home scratch (arg0 symlinks, plugin caches) is
      // excluded before traversal, so the portable-archive symlink guard
      // never sees the absolute adapter links.
      expect(entries.some((entry) => entry.includes("/codex-home/tmp/arg0/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/codex-home/.tmp/plugins/"))).toBe(false);
      expect(result.skipped).toContainEqual(
        expect.objectContaining({ sourcePath: arg0Root, reason: "regenerable" }),
      );
      expect(result.skipped).toContainEqual(
        expect.objectContaining({
          sourcePath: path.join(codexHome, ".tmp", "plugins"),
          reason: "regenerable",
        }),
      );
      await expect(verifyBackupArchive(result.archivePath)).resolves.toMatchObject({ ok: true });
    });
  });

  it.each([
    {
      fallback: "Date.now",
      dateNow: Date.UTC(2026, 4, 30, 12, 0, 0),
      createdAt: "2026-05-30T12:00:00.000Z",
    },
    {
      fallback: "epoch when Date.now is also outside Date range",
      dateNow: 8_640_000_000_000_001,
      createdAt: "1970-01-01T00:00:00.000Z",
    },
  ])(
    "falls back to $fallback when injected nowMs is outside Date range",
    async ({ dateNow, createdAt }) => {
      await withBackupState("openclaw-backup-invalid-now-", async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(dateNow);
        try {
          const result = await createBackupArchive({
            output: outputDir,
            dryRun: true,
            includeWorkspace: false,
            nowMs: 8_640_000_000_000_001,
          });
          expect(result.createdAt).toBe(createdAt);
          expect(path.basename(result.archivePath)).toContain("openclaw-backup.tar.gz");
          expect(path.basename(result.archivePath)).not.toContain("NaN");
        } finally {
          dateNowSpy.mockRestore();
        }
      });
    },
  );

  it("skips current live volatile state files while preserving workspace locks", async () => {
    await withOpenClawTestState(
      {
        layout: "split",
        prefix: "openclaw-backup-volatile-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await state.writeConfig({
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
          },
        });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "Cargo.lock"), "workspace lock\n", "utf8");
        await fs.writeFile(
          path.join(state.workspaceDir, "pending.tmp"),
          "workspace temp fixture\n",
          "utf8",
        );
        await state.writeText("agents/main/sessions/live-session.jsonl", "session\n");
        await state.writeText("sessions/legacy-session.jsonl", "legacy session\n");
        await state.writeText("cron/runs/nightly.jsonl", "cron\n");
        await state.writeText("logs/gateway.log", "log\n");
        await state.writeJson("delivery-queue/message.json", { id: "delivery" });
        await state.writeText("delivery-queue/message.delivered", '{"id":"delivery"}\n');
        await state.writeJson("session-delivery-queue/message.json", { id: "session-delivery" });
        await state.writeText(
          "session-delivery-queue/message.delivered",
          '{"id":"session-delivery"}\n',
        );
        await state.writeText("tmp/staged.tmp", "tmp\n");
        await state.writeText("gateway.pid", "123\n");

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 4, 9, 8, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expectArchivePath(entries, "/workspace/Cargo.lock", true);
        expectArchivePath(entries, "/workspace/pending.tmp", false);
        for (const suffix of [
          "/state/agents/main/sessions/live-session.jsonl",
          "/state/sessions/legacy-session.jsonl",
          "/state/cron/runs/nightly.jsonl",
          "/state/logs/gateway.log",
          "/state/delivery-queue/message.json",
          "/state/delivery-queue/message.delivered",
          "/state/session-delivery-queue/message.json",
          "/state/session-delivery-queue/message.delivered",
          "/state/tmp/staged.tmp",
          "/state/gateway.pid",
        ]) {
          expect(
            entries.some((entry) => entry.endsWith(suffix)),
            suffix,
          ).toBe(false);
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
      const runtime = createTestRuntime();

      await expect(
        backupVerifyCommand(runtime, { archive: result.archivePath }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  it("scrubs transient SQLite queue and plugin blob rows from archive snapshots", async () => {
    await withBackupState("openclaw-backup-sqlite-queue-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      const { db } = openOpenClawStateDatabase({ env: state.env });
      db.prepare(
        `
          INSERT INTO delivery_queue_entries (
            queue_name, id, status, session_key, channel, target, retry_count, last_error,
            entry_json, enqueued_at, updated_at, failed_at
          ) VALUES (
            'outbound', 'failed-1', 'failed', 'agent:main:private', 'telegram', 'secret-target',
            2, 'raw provider error',
            '{"id":"failed-1","message":"sensitive failed delivery"}', 10, 20, 20
          )
        `,
      ).run();
      const transientBlobMarker = `transient-diffs-blob-${"sensitive".repeat(32)}`;
      const durableBlobMarker = "durable-plugin-blob-control";
      const insertPluginBlob = db.prepare(
        `
          INSERT INTO plugin_blob_entries (
            plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertPluginBlob.run(
        "diffs",
        "viewer-artifacts",
        "transient",
        JSON.stringify({ marker: transientBlobMarker }),
        Buffer.from(`<html>${transientBlobMarker}</html>`),
        10,
        Date.UTC(2099, 0, 1),
      );
      insertPluginBlob.run(
        "durable-plugin",
        "documents",
        "durable",
        JSON.stringify({ kind: "durable" }),
        Buffer.from(durableBlobMarker),
        10,
        null,
      );
      db.prepare(
        `
          INSERT INTO state_leases (
            scope, lease_key, owner, expires_at, heartbeat_at,
            payload_json, created_at, updated_at
          ) VALUES ('core:test-fixture', 'write', 'worker', 9999999999999, 10, NULL, 10, 10)
        `,
      ).run();

      try {
        const result = await createStateArchive(outputDir);
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith("/state/state/openclaw.sqlite"),
        );
        expect(archivedDbEntry).toBeDefined();
        expectArchivePath(entries, "/state/state/openclaw.sqlite-wal", false);

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const sqlite = requireNodeSqlite();
        const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
          readOnly: true,
        });
        try {
          expect(
            archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
          ).toEqual({ count: 0 });
          expect(
            archivedDb
              .prepare(
                "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
              )
              .all(),
          ).toEqual([{ plugin_id: "durable-plugin", entry_key: "durable" }]);
          expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 0,
          });
        } finally {
          archivedDb.close();
        }
        const archivedBytes = await fs.readFile(path.join(extractDir, archivedDbEntry!));
        expect(archivedBytes.includes(transientBlobMarker)).toBe(false);
        expect(archivedBytes.includes(durableBlobMarker)).toBe(true);

        expect(db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get()).toEqual({
          count: 1,
        });
        expect(
          db
            .prepare(
              "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
            )
            .all(),
        ).toEqual([
          { plugin_id: "diffs", entry_key: "transient" },
          { plugin_id: "durable-plugin", entry_key: "durable" },
        ]);
        expect(db.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
          count: 1,
        });
      } finally {
        closeOpenClawStateDatabase();
      }
    });
  });

  it("rejects stale secondary indexes before creating a backup archive", async () => {
    await withBackupState("openclaw-backup-unsafe-index-", async (state) => {
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir, { recursive: true });
      openOpenClawStateDatabase({ env: state.env });
      closeOpenClawStateDatabase();
      createUnsafeIndexDrift(resolveOpenClawStateSqlitePath(state.env));

      await expect(createStateArchive(outputDir)).rejects.toThrow(
        /integrity_check failed.*missing from index unsafe_index_records_value/iu,
      );
      expect(await fs.readdir(outputDir)).toEqual([]);
    });
  });

  it("rejects repairable task-delivery orphans before creating a backup archive", async () => {
    await withBackupState("openclaw-backup-foreign-key-", async (state) => {
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir, { recursive: true });
      openOpenClawStateDatabase({ env: state.env });
      closeOpenClawStateDatabase();

      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
      let originalUserVersion: unknown;
      let originalSchemaMetadata: unknown;
      try {
        originalUserVersion = database.prepare("PRAGMA user_version").get();
        originalSchemaMetadata = database
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get();
        database.exec("PRAGMA foreign_keys = OFF;");
        database
          .prepare("INSERT INTO task_delivery_state (task_id) VALUES (?)")
          .run("missing-task");
        expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        database.close();
      }

      await expect(createStateArchive(outputDir)).rejects.toThrow(
        /repairable task_delivery_state\.task_id references task_runs\.task_id.*\(1 rows\).*openclaw doctor --fix/iu,
      );
      expect(await fs.readdir(outputDir)).toEqual([]);
      const unchanged = new sqlite.DatabaseSync(resolveOpenClawStateSqlitePath(state.env), {
        readOnly: true,
      });
      try {
        expect(unchanged.prepare("SELECT task_id FROM task_delivery_state").all()).toEqual([
          { task_id: "missing-task" },
        ]);
        expect(unchanged.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
        expect(unchanged.prepare("PRAGMA user_version").get()).toEqual(originalUserVersion);
        expect(
          unchanged
            .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
            .get(),
        ).toEqual(originalSchemaMetadata);
      } finally {
        unchanged.close();
      }
    });
  });

  it("snapshots per-agent SQLite auth stores without deleted secret pages", async () => {
    await withBackupState("openclaw-backup-agent-sqlite-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-backup",
            },
          },
        },
        state.agentDir(),
        { syncExternalCli: false },
      );
      closeOpenClawAgentDatabasesForTest();
      const sqlite = requireNodeSqlite();
      const liveDbPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const deletedSecretMarker = "OPENCLAW_DELETED_SECRET_PAGE_MARKER";
      const deletedSecret = `${deletedSecretMarker}-${"x".repeat(16_384)}`;
      const liveDb = new sqlite.DatabaseSync(liveDbPath);
      try {
        liveDb.exec("PRAGMA secure_delete = OFF; CREATE TABLE deleted_secrets (value TEXT)");
        liveDb.prepare("INSERT INTO deleted_secrets (value) VALUES (?)").run(deletedSecret);
        liveDb
          .prepare("INSERT INTO deleted_secrets (value) VALUES (?)")
          .run(`keeper-${"y".repeat(16_384)}`);
        liveDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        liveDb.prepare("DELETE FROM deleted_secrets WHERE value = ?").run(deletedSecret);
      } finally {
        liveDb.close();
      }
      expect((await fs.readFile(liveDbPath)).includes(Buffer.from(deletedSecretMarker))).toBe(true);

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);
      const archivedDbEntry = entries.find((entry) =>
        entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite"),
      );
      expect(archivedDbEntry).toBeDefined();
      expect(
        entries.some((entry) =>
          entry.endsWith("/state/agents/main/agent/openclaw-agent.sqlite-wal"),
        ),
      ).toBe(false);

      await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
      const extractedPath = path.join(extractDir, archivedDbEntry!);
      expect((await fs.stat(extractedPath)).mode & 0o777).toBe(0o600);
      expect((await fs.readFile(extractedPath)).includes(Buffer.from(deletedSecretMarker))).toBe(
        false,
      );
      const archivedDb = new sqlite.DatabaseSync(extractedPath, {
        readOnly: true,
      });
      try {
        const row = archivedDb
          .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
          .get() as { store_json: string };
        expect(JSON.parse(row.store_json).profiles["openai:default"]).toMatchObject({
          type: "api_key",
          provider: "openai",
          key: "sk-backup",
        });
      } finally {
        archivedDb.close();
      }
    });
  });

  it("snapshots and verifies a canonical agent database when the agent id is node_modules", async () => {
    await withBackupState("openclaw-backup-agent-node-modules-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const dbPath = state.statePath("agents", "node_modules", "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      registerAgentDatabase(state, dbPath, "node_modules");
      const sqlite = requireNodeSqlite();
      const db = new sqlite.DatabaseSync(dbPath);
      try {
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE schema_meta (
            meta_key TEXT NOT NULL PRIMARY KEY,
            role TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            agent_id TEXT
          );
          INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
          VALUES ('primary', 'agent', 1, 'node_modules');
          PRAGMA user_version = 1;
          CREATE TABLE markers (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA wal_checkpoint(TRUNCATE);
          INSERT INTO markers (value) VALUES ('committed-in-wal');
        `);
        await fs.access(`${dbPath}-wal`);

        const result = await createStateArchive(outputDir);
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith("/state/agents/node_modules/agent/openclaw-agent.sqlite"),
        );
        expect(archivedDbEntry).toBeDefined();
        expect(
          entries.some((entry) =>
            entry.endsWith("/state/agents/node_modules/agent/openclaw-agent.sqlite-wal"),
          ),
        ).toBe(false);

        const runtime = createTestRuntime();
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry!), {
          readOnly: true,
        });
        try {
          expect(archivedDb.prepare("SELECT value FROM markers").get()).toEqual({
            value: "committed-in-wal",
          });
        } finally {
          archivedDb.close();
        }
      } finally {
        db.close();
      }
    });
  });

  it.each<
    [string, "global" | "agent", (sqlitePath: string) => void | Promise<void>, RegExp, boolean?]
  >([
    [
      "external agent with different owner",
      "agent",
      (sqlitePath) => createOwnedSqliteDatabase({ sqlitePath, role: "agent", agentId: "other" }),
      /belongs to agent other; requested agent main/iu,
      true,
    ],
    [
      "zero-byte global",
      "global",
      (sqlitePath) => fs.writeFile(sqlitePath, ""),
      /snapshot source must not be empty/iu,
    ],
    [
      "zero-byte agent",
      "agent",
      (sqlitePath) => fs.writeFile(sqlitePath, ""),
      /snapshot source must not be empty/iu,
    ],
    [
      "schema-empty global",
      "global",
      createEmptySqliteDatabase,
      /schema role missing|no schema ownership metadata/iu,
    ],
    [
      "schema-empty agent",
      "agent",
      createEmptySqliteDatabase,
      /schema role missing|no schema ownership metadata/iu,
    ],
    [
      "global with agent role",
      "global",
      (sqlitePath) => createOwnedSqliteDatabase({ sqlitePath, role: "agent", agentId: "main" }),
      /schema role agent; expected global/iu,
    ],
    [
      "agent with global role",
      "agent",
      (sqlitePath) => createOwnedSqliteDatabase({ sqlitePath, role: "global" }),
      /schema role global; expected agent/iu,
    ],
    [
      "agent with different owner",
      "agent",
      (sqlitePath) => createOwnedSqliteDatabase({ sqlitePath, role: "agent", agentId: "worker" }),
      /belongs to agent worker; requested agent main/iu,
    ],
    [
      "agent with noncanonical owner",
      "agent",
      (sqlitePath) => createOwnedSqliteDatabase({ sqlitePath, role: "agent", agentId: "Main" }),
      /belongs to agent Main; requested agent main/iu,
    ],
  ])(
    "rejects a managed %s database without changing its bytes before outcome recording",
    async (_name, kind, createDatabase, expected, external) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-invalid-owner-", scenario: "minimal" },
        async (state) => {
          const outputDir = state.path("backups");
          const dbPath = external
            ? state.path("external-agent", "openclaw-agent.sqlite")
            : resolveCanonicalTestSqlitePath(state, kind);
          if (external) {
            await state.writeConfig({
              agents: { entries: { main: { agentDir: path.dirname(dbPath) } } },
            });
          }
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
          await fs.mkdir(outputDir, { recursive: true });
          if (kind === "agent") {
            registerAgentDatabase(state, dbPath);
          }
          await createDatabase(dbPath);
          const sourceBytes = await fs.readFile(dbPath);
          const recordOutcome = backupRunRecords.recordBackupRunOutcome;
          let bytesBeforeOutcome: Buffer | undefined;
          const outcomeSpy = vi
            .spyOn(backupRunRecords, "recordBackupRunOutcome")
            .mockImplementation(async (params) => {
              bytesBeforeOutcome = await fs.readFile(dbPath);
              await recordOutcome(params);
            });
          try {
            await expect(
              backupCreateCommand(createTestRuntime(), {
                output: outputDir,
                includeWorkspace: false,
              }),
            ).rejects.toThrow(expected);
            expect(outcomeSpy).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ status: "failed" }),
            );
            expect(bytesBeforeOutcome).toEqual(sourceBytes);
            if (kind === "agent") {
              expect(await fs.readFile(dbPath)).toEqual(sourceBytes);
            }
            expect(await fs.readdir(outputDir)).toEqual([]);
          } finally {
            outcomeSpy.mockRestore();
          }
        },
      );
    },
  );

  it("creates, verifies, and restores foreign SQLite files as opaque bytes", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-foreign-sqlite-",
        scenario: "minimal",
      },
      async (state) => {
        // Keep concurrent backups out of this fixture's warning inventory.
        const scratchRoot = state.path("scratch");
        await fs.mkdir(scratchRoot);
        Object.assign(state.envVars, { TMPDIR: scratchRoot, TMP: scratchRoot, TEMP: scratchRoot });
        state.applyEnv();
        const databasePaths = [
          state.statePath("browser", "foreign-browser.sqlite"),
          state.statePath("plugins", "dedicated", "foreign-plugin.sqlite"),
          state.statePath("agents", "Main", "agent", "foreign-agent.sqlite"),
        ];
        const sourcePath = expectDefined(databasePaths[0], "foreign SQLite source");
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        const sqlite = requireNodeSqlite();
        const database = new sqlite.DatabaseSync(sourcePath);
        try {
          database.exec(`
            PRAGMA foreign_keys = OFF;
            CREATE TABLE parents (id INTEGER PRIMARY KEY);
            CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));
            INSERT INTO children VALUES (7);
          `);
          expect(database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
        } finally {
          database.close();
        }
        const sourceBytes = await fs.readFile(sourcePath);
        for (const databasePath of databasePaths.slice(1)) {
          await fs.mkdir(path.dirname(databasePath), { recursive: true });
          await fs.writeFile(databasePath, sourceBytes);
        }
        const opaqueFiles = new Map(
          databasePaths.map((databasePath) => [databasePath, sourceBytes]),
        );
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const sidecarPath = `${sourcePath}${suffix}`;
          const sidecarBytes = Buffer.from(`foreign sidecar ${suffix}`);
          await fs.writeFile(sidecarPath, sidecarBytes);
          opaqueFiles.set(sidecarPath, sidecarBytes);
        }

        const runtime = createTestRuntime();
        const archive = await backupCreateCommand(runtime, {
          output: state.path("foreign.tar.gz"),
          includeWorkspace: false,
        });
        expect(archive.warnings, JSON.stringify(archive.warnings)).toHaveLength(opaqueFiles.size);
        for (const databasePath of opaqueFiles.keys()) {
          expect(
            archive.warnings?.filter(
              (warning) =>
                warning.endsWith(path.basename(databasePath)) && warning.includes("opaque"),
            ),
          ).toHaveLength(1);
        }
        await expect(
          backupVerifyCommand(runtime, { archive: archive.archivePath }),
        ).resolves.toMatchObject({ ok: true });
        const restored = await backupRestoreCommand(runtime, {
          archive: archive.archivePath,
          target: state.path("restored"),
        });
        const entries = await listArchiveEntries(archive.archivePath);
        for (const [sourceFile, bytes] of opaqueFiles) {
          const suffix = `/state/${path.relative(state.stateDir, sourceFile).split(path.sep).join("/")}`;
          const entry = expectDefined(
            entries.find((candidate) => candidate.endsWith(suffix)),
            suffix,
          );
          expect(await fs.readFile(path.join(restored.targetPath, entry))).toEqual(bytes);
          expect(await fs.readFile(sourceFile)).toEqual(bytes);
        }
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when a canonical SQLite symlink retargets after discovery",
    async () => {
      await withBackupState("openclaw-backup-canonical-symlink-retarget-", async (state) => {
        const outputDir = state.path("backups");
        const canonicalDbPath = resolveCanonicalTestSqlitePath(state, "global");
        const firstDbPath = state.statePath("state", "first-global.sqlite");
        const secondDbPath = state.statePath("state", "second-global.sqlite");
        await fs.mkdir(path.dirname(canonicalDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        createOwnedSqliteDatabase({
          sqlitePath: firstDbPath,
          role: "global",
        });
        createOwnedSqliteDatabase({
          sqlitePath: secondDbPath,
          role: "global",
        });
        await fs.symlink(firstDbPath, canonicalDbPath);

        const originalRealpath = fs.realpath.bind(fs);
        let retargeted = false;
        const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
          const resolved = await originalRealpath(target);
          if (!retargeted && path.resolve(String(target)) === path.resolve(canonicalDbPath)) {
            retargeted = true;
            await fs.unlink(canonicalDbPath);
            await fs.symlink(secondDbPath, canonicalDbPath);
          }
          return resolved;
        });

        try {
          await expect(createStateArchive(outputDir)).rejects.toThrow(
            /Canonical SQLite path changed after discovery/iu,
          );
          expect(retargeted).toBe(true);
          expect(await fs.readdir(outputDir)).toEqual([]);
        } finally {
          realpathSpy.mockRestore();
        }
      });
    },
  );

  it.each(["global", "agent"] as const)(
    "backs up an older owned %s database and a declared schema-empty plugin database",
    async (kind) => {
      await withBackupState("openclaw-backup-owned-older-schema-", async (state) => {
        await declarePluginSqliteResources(state);
        const databasePath = resolveCanonicalTestSqlitePath(state, kind);
        const pluginDbPath = state.statePath("plugins", "dedicated", "empty.sqlite");
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        await fs.mkdir(path.dirname(pluginDbPath), { recursive: true });
        if (kind === "agent") {
          registerAgentDatabase(state, databasePath);
        }
        createOwnedSqliteDatabase({
          sqlitePath: databasePath,
          role: kind,
          ...(kind === "agent" ? { agentId: "main" } : {}),
          schemaVersion: 1,
        });
        createEmptySqliteDatabase(pluginDbPath);
        const sourceBytes = await fs.readFile(databasePath);

        const recordOutcome = backupRunRecords.recordBackupRunOutcome;
        let bytesBeforeOutcome: Buffer | undefined;
        const outcomeSpy = vi
          .spyOn(backupRunRecords, "recordBackupRunOutcome")
          .mockImplementation(async (params) => {
            bytesBeforeOutcome = await fs.readFile(databasePath);
            await recordOutcome(params);
          });
        try {
          const result = await backupCreateCommand(createTestRuntime(), {
            output: state.path("older-schema.tar.gz"),
            includeWorkspace: false,
          });
          const entries = await listArchiveEntries(result.archivePath);
          for (const dbPath of [databasePath, pluginDbPath]) {
            const suffix = `/state/${path.relative(state.stateDir, dbPath).split(path.sep).join("/")}`;
            expectArchivePath(entries, suffix, true);
          }
          await expect(
            backupVerifyCommand(createTestRuntime(), { archive: result.archivePath }),
          ).resolves.toMatchObject({ ok: true });

          expect(outcomeSpy).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ status: "ok" }),
          );
          expect(bytesBeforeOutcome).toEqual(sourceBytes);
          if (kind === "agent") {
            expect(await fs.readFile(databasePath)).toEqual(sourceBytes);
          }
        } finally {
          outcomeSpy.mockRestore();
        }
      });
    },
  );

  it("snapshots lock-named plugin SQLite databases with transaction continuity", async () => {
    await withBackupState("openclaw-backup-nested-sqlite-", async (state) => {
      await declarePluginSqliteResources(state);
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const dbPath = state.statePath("plugins", "dedicated", "cache.lock.sqlite");
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      const sqlite = requireNodeSqlite();
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE backup_meta (
          id INTEGER PRIMARY KEY,
          last_seq INTEGER NOT NULL
        );
        CREATE TABLE backup_markers (
          seq INTEGER PRIMARY KEY,
          transaction_id INTEGER NOT NULL
        );
        CREATE TABLE delivery_queue_entries (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL
        );
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

      try {
        await fs.access(`${dbPath}-wal`);
        await fs.access(`${dbPath}-shm`);
        const result = await createStateArchive(outputDir);
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntries = entries.filter((entry) =>
          entry.endsWith("/state/plugins/dedicated/cache.lock.sqlite"),
        );
        expect(archivedDbEntries).toHaveLength(1);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          expect(
            entries.some((entry) =>
              entry.endsWith(`/state/plugins/dedicated/cache.lock.sqlite${suffix}`),
            ),
            suffix,
          ).toBe(false);
        }

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const archivedDb = new sqlite.DatabaseSync(
          path.join(
            extractDir,
            expectDefined(archivedDbEntries[0], "archivedDbEntries[0] test invariant"),
          ),
          {
            readOnly: true,
          },
        );
        try {
          expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
          expect(archivedDb.prepare("SELECT last_seq FROM backup_meta WHERE id = 1").get()).toEqual(
            { last_seq: 3 },
          );
          expect(
            archivedDb
              .prepare(
                "SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM backup_markers",
              )
              .get(),
          ).toEqual({ count: 3, min_seq: 1, max_seq: 3 });
          expect(
            archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
          ).toEqual({ count: 1 });
          expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
            count: 1,
          });
        } finally {
          archivedDb.close();
        }
      } finally {
        db.close();
      }
    });
  });

  it("fails closed when a plugin SQLite schema cannot be compacted safely", async () => {
    await withBackupState("openclaw-backup-plugin-capability-", async (state) => {
      await declarePluginSqliteResources(state);
      const outputDir = state.path("backups");
      const dbPath = state.statePath("plugins", "dedicated", "custom.sqlite");
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      const sqlite = requireNodeSqlite();
      const db = new sqlite.DatabaseSync(dbPath);
      db.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
      db.exec(`
        CREATE TABLE records (value INTEGER NOT NULL);
        INSERT INTO records (value) VALUES (1), (2);
        CREATE INDEX records_double ON records(plugin_double(value));
      `);
      db.close();

      await expect(createStateArchive(outputDir)).rejects.toThrow(
        /cannot be compacted safely.*custom\.sqlite/iu,
      );
    });
  });

  it.each(["deleted.sqlite", "._cron.sqlite"])(
    "scrubs deleted plugin SQLite bytes from archive snapshots: %s",
    async (filename) => {
      await withBackupState("openclaw-backup-plugin-deleted-bytes-", async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const dbPath = state.statePath("plugins", "dedicated", filename);
        const deletedValue = `deleted-plugin-secret-${"x".repeat(256)}`;
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.exec("PRAGMA secure_delete = OFF; CREATE TABLE records (value TEXT NOT NULL);");
        const insert = db.prepare("INSERT INTO records (value) VALUES (?)");
        insert.run("survivor");
        insert.run(deletedValue);
        db.prepare("DELETE FROM records WHERE value = ?").run(deletedValue);
        db.close();

        expect((await fs.readFile(dbPath)).includes(deletedValue)).toBe(true);
        const result = await createStateArchive(outputDir);
        const entries = await listArchiveEntries(result.archivePath);
        const archivedDbEntry = entries.find((entry) =>
          entry.endsWith(`/state/plugins/dedicated/${filename}`),
        );
        expect(archivedDbEntry).toBeDefined();

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        const archivedPath = path.join(extractDir, archivedDbEntry!);
        expect((await fs.readFile(archivedPath)).includes(deletedValue)).toBe(false);
        const archivedDb = new sqlite.DatabaseSync(archivedPath, { readOnly: true });
        try {
          expect(archivedDb.prepare("SELECT value FROM records").all()).toEqual([
            { value: "survivor" },
          ]);
        } finally {
          archivedDb.close();
        }
      });
    },
  );

  it.each(["malformed.sqlite", "._cron.sqlite"])(
    "fails instead of raw-copying malformed declared plugin SQLite databases: %s",
    async (filename) => {
      await withBackupState("openclaw-backup-malformed-sqlite-", async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        const dbPath = state.statePath("plugins", "dedicated", filename);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(dbPath, "not a sqlite database", "utf8");

        await expect(createStateArchive(outputDir)).rejects.toThrow(
          /file is not a database|malformed/i,
        );
      });
    },
  );

  it.each(["late.sqlite", "late.sqlite-wal"])(
    "fails when declared plugin SQLite appears after snapshot discovery: %s",
    async (lateName) => {
      await withBackupState("openclaw-backup-late-sqlite-", async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        const latePath = state.statePath("plugins", "dedicated", lateName);
        await fs.mkdir(path.dirname(latePath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });

        const originalReaddir = fs.readdir.bind(fs);
        let createdLatePath = false;
        let stagedArchiveCleanupAttempts = 0;
        const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
          ...args: unknown[]
        ) => {
          const entries = await (
            originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>
          )(...args);
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
        const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
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

        try {
          await expect(createStateArchive(outputDir)).rejects.toThrow(
            /SQLite state appeared after snapshot discovery/,
          );
          expect(createdLatePath).toBe(true);
          expect(stagedArchiveCleanupAttempts).toBeGreaterThanOrEqual(2);
          expect(await fs.readdir(outputDir)).toEqual([]);
        } finally {
          unlinkSpy.mockRestore();
          readdirSpy.mockRestore();
        }
      });
    },
  );

  it("omits pre-existing orphan SQLite sidecars without failing backup", async () => {
    await withBackupState("openclaw-backup-orphan-sqlite-sidecars-", async (state) => {
      await declarePluginSqliteResources(state);
      const outputDir = state.path("backups");
      const orphanPath = state.statePath("plugins", "dedicated", "orphan.sqlite");
      await fs.mkdir(path.dirname(orphanPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        await fs.writeFile(`${orphanPath}${suffix}`, "orphan SQLite sidecar");
      }

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(
          entries.some((entry) =>
            entry.endsWith(`/state/plugins/dedicated/orphan.sqlite${suffix}`),
          ),
          suffix,
        ).toBe(false);
      }
    });
  });

  it("omits transient memory reindex databases and sidecars", async () => {
    await withBackupState("openclaw-backup-memory-reindex-lock-", async (state) => {
      const outputDir = state.path("backups");
      const transientPaths = [
        state.statePath("memory", "main.sqlite.reindex-lock.sqlite"),
        state.statePath("memory", "main.sqlite.generation-writer.sqlite"),
        state.statePath("memory", "main.sqlite.generation-lock.sqlite"),
        state.statePath("memory", "main.sqlite.tmp-11111111-2222-3333-4444-555555555555"),
        state.statePath("memory", "main.sqlite.backup-66666666-7777-8888-9999-aaaaaaaaaaaa"),
        state.statePath(
          "agents",
          "main",
          "agent.sqlite.memory-reindex-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        ),
      ];
      await fs.mkdir(outputDir, { recursive: true });
      for (const transientPath of transientPaths) {
        await fs.mkdir(path.dirname(transientPath), { recursive: true });
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          await fs.writeFile(`${transientPath}${suffix}`, "transient reindex database");
        }
      }

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);
      for (const transientPath of transientPaths) {
        const relativeTransientPath = path
          .relative(state.stateDir, transientPath)
          .split(path.sep)
          .join("/");
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          expect(
            entries.some((entry) => entry.endsWith(`/state/${relativeTransientPath}${suffix}`)),
            `${relativeTransientPath}${suffix}`,
          ).toBe(false);
        }
      }
    });
  });

  it("excludes the state-local gateway lock tree while backing up durable SQLite", async () => {
    await withBackupState("openclaw-backup-gateway-lock-sqlite-", async (state) => {
      await declarePluginSqliteResources(state);
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const lockDir = resolveGatewayLockDir(state.stateDir);
      const pluginDbPath = state.statePath("plugins", "dedicated", "durable.sqlite");
      const producerShapedDbPath = state.statePath(
        "plugins",
        "dedicated",
        "gateway.12345678.lock.sqlite",
      );
      const colocatedDbPath = path.join(lockDir, "retained.sqlite");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      await fs.mkdir(path.dirname(pluginDbPath), { recursive: true });
      await fs.mkdir(lockDir, { recursive: true });

      const sqlite = requireNodeSqlite();
      for (const [databasePath, value] of [
        [pluginDbPath, "plugin-state"],
        [producerShapedDbPath, "producer-shaped-state"],
        [colocatedDbPath, "colocated-state"],
      ] as const) {
        const database = new sqlite.DatabaseSync(databasePath);
        try {
          database.exec("CREATE TABLE durable_state (value TEXT NOT NULL)");
          database.prepare("INSERT INTO durable_state (value) VALUES (?)").run(value);
        } finally {
          database.close();
        }
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
        state.statePath("memory", "main.sqlite.reindex-lock.sqlite"),
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
          const relativeTransientPath = path
            .relative(state.stateDir, transientPath)
            .split(path.sep)
            .join("/");
          for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            expect(
              entries.some((entry) => entry.endsWith(`/state/${relativeTransientPath}${suffix}`)),
              `${relativeTransientPath}${suffix}`,
            ).toBe(false);
          }
        }
        expectArchivePath(entries, "/state/plugins/dedicated/durable.sqlite", true);
        expect(
          entries.some((entry) =>
            entry.endsWith("/state/plugins/dedicated/gateway.12345678.lock.sqlite"),
          ),
        ).toBe(true);
        expect(entries.some((entry) => entry.includes(`/${path.basename(lockDir)}/`))).toBe(false);

        const runtime = createTestRuntime();
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        for (const [entrySuffix, value] of [
          ["/state/plugins/dedicated/durable.sqlite", "plugin-state"],
          ["/state/plugins/dedicated/gateway.12345678.lock.sqlite", "producer-shaped-state"],
        ] as const) {
          const archivedEntry = expectDefined(
            entries.find((entry) => entry.endsWith(entrySuffix)),
            `archive entry ending with ${entrySuffix}`,
          );
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedEntry), {
            readOnly: true,
          });
          try {
            expect(archivedDb.prepare("SELECT value FROM durable_state").get()).toEqual({
              value,
            });
          } finally {
            archivedDb.close();
          }
        }
      } finally {
        await gatewayLock.release();
      }
    });
  });

  it.runIf(process.platform !== "win32").each<{
    label: string;
    relative: boolean;
    targetExists: boolean;
    directory: boolean;
    internal: boolean;
    cyclic?: boolean;
    marker?: "valid" | "malformed" | "unreadable";
  }>([
    {
      label: "absolute file",
      relative: false,
      targetExists: true,
      directory: false,
      internal: false,
    },
    {
      label: "absolute directory",
      relative: false,
      targetExists: true,
      directory: true,
      internal: false,
    },
    {
      label: "dangling absolute",
      relative: false,
      targetExists: false,
      directory: false,
      internal: false,
    },
    {
      label: "external relative",
      relative: true,
      targetExists: true,
      directory: false,
      internal: false,
    },
    {
      label: "internal relative",
      relative: true,
      targetExists: true,
      directory: false,
      internal: true,
    },
    {
      label: "cyclic relative",
      relative: true,
      targetExists: false,
      directory: false,
      internal: true,
      cyclic: true,
    },
    ...(["valid", "malformed", "unreadable"] as const).map((marker) => ({
      label: `${marker} marked directory`,
      relative: false,
      targetExists: true,
      directory: true,
      internal: false,
      marker,
    })),
  ])(
    "backupCreateCommand applies privacy to $label links through backupRestoreCommand",
    async ({ relative, targetExists, directory, internal, cyclic, marker }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-symbolic-link-", scenario: "minimal" },
        async (state) => {
          const targetPath = internal
            ? state.statePath("target.txt")
            : state.path("outside-target");
          if (directory) {
            await fs.mkdir(targetPath);
            await fs.writeFile(path.join(targetPath, "external.txt"), "outside\n");
            if (marker) {
              await fs.writeFile(
                path.join(targetPath, ".openclaw-private-update-capture"),
                marker === "malformed" ? "invalid" : "openclaw-private-update-capture-v1\n",
                { mode: marker === "unreadable" ? 0o000 : 0o600 },
              );
            }
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
            await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
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
            const restored = state.path("restored");
            await backupRestoreCommand(runtime, { archive: result.archivePath, target: restored });
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
            expect(runtime.log).toHaveBeenCalledWith(
              expect.stringContaining(JSON.stringify(linkpath)),
            );
          }
          const restored = state.path("restored");
          await backupRestoreCommand(runtime, { archive: result.archivePath, target: restored });
          const restoredLink = path.join(restored, link.path);
          expect(await fs.readlink(restoredLink)).toBe(linkpath);
          if (cyclic) {
            expect(await fs.readlink(path.join(path.dirname(restoredLink), "target.txt"))).toBe(
              "ordinary-link",
            );
          } else if (internal) {
            expect(await fs.readFile(restoredLink, "utf8")).toBe("target\n");
          } else if (!targetExists) {
            await expect(fs.stat(restoredLink)).rejects.toMatchObject({ code: "ENOENT" });
          }
          const manifest = JSON.parse(
            await fs.readFile(path.join(restored, result.archiveRoot, "manifest.json"), "utf8"),
          );
          expect(manifest.externalSymbolicLinks ?? []).toEqual(externalSymbolicLinks);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each([
    { label: "direct config", kind: "config" as const, hops: 1 },
    { label: "backslash config", kind: "config" as const, hops: 1, backslash: true },
    { label: "relative config", kind: "config" as const, hops: 1, relative: true },
    { label: "chained config", kind: "config" as const, hops: 2 },
    { label: "direct credentials", kind: "credentials" as const, hops: 1 },
    { label: "relative credentials", kind: "credentials" as const, hops: 1, relative: true },
    { label: "chained credentials", kind: "credentials" as const, hops: 2 },
    { label: "volatile-path config", kind: "config" as const, hops: 1, volatile: true },
    {
      label: "volatile-path credentials",
      kind: "credentials" as const,
      hops: 1,
      volatile: true,
    },
  ])(
    "backupCreateCommand and backupRestoreCommand preserve the first hop of a $label link",
    async ({ kind, hops, volatile, relative, backslash }) => {
      await withBackupState("openclaw-backup-declared-config-symlink-", async (state) => {
        const outputPath = state.path(`declared-${kind}-symlink.tar.gz`);
        const restorePath = state.path(`restored-${kind}`);
        const sourcePath = volatile
          ? state.statePath(
              "cache.tmp",
              "managed",
              kind === "config" ? "openclaw.json" : "credentials",
            )
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
          await fs.mkdir(path.dirname(sourcePath), { recursive: true });
          await fs.writeFile(path.join(path.dirname(sourcePath), "neighbor.tmp"), "omit\n");
          await fs.writeFile(path.join(path.dirname(sourcePath), "neighbor.json"), "omit\n");
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
          kind === "config"
            ? externalSourcePath
            : path.join(externalSourcePath, "credentials.json");
        const expectedContents = await fs.readFile(sourceContentsPath, "utf8");

        const result = await backupCreateCommand(createTestRuntime(), {
          output: outputPath,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 8, 2, 13, 0, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);
        const sourceArchiveSuffix = path
          .relative(state.stateDir, sourcePath)
          .split(path.sep)
          .join(path.posix.sep);
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

        expect(archivedLink.type).toBe("SymbolicLink");
        expect(archivedLink.linkpath).toBe(linkTarget);
        expect(result.externalSymbolicLinks).toContainEqual({
          entryPath: archivedLink.path,
          linkpath: linkTarget,
        });
        expect(managedAsset.sourcePath).toBe(canonicalExternalSourcePath);
        if (volatile) {
          expect(result.assets).toContainEqual(expect.objectContaining({ kind, sourcePath }));
          const neighborArchiveSuffix = path
            .relative(state.stateDir, path.dirname(sourcePath))
            .split(path.sep)
            .join(path.posix.sep);
          expect(
            entries.some((entry) =>
              ["neighbor.json", "neighbor.tmp"].some((neighbor) =>
                entry.path.endsWith(`/state/${neighborArchiveSuffix}/${neighbor}`),
              ),
            ),
          ).toBe(false);
        }

        const runtime = createTestRuntime();
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
        await backupRestoreCommand(runtime, { archive: result.archivePath, target: restorePath });

        const restoredLinkPath = path.join(restorePath, archivedLink.path);
        const restoredAssetPath = path.join(restorePath, managedAsset.archivePath);
        expect(await fs.readlink(restoredLinkPath)).toBe(archivedLink.linkpath);
        const restoredContentsPath =
          kind === "config" ? restoredAssetPath : path.join(restoredAssetPath, "credentials.json");
        await expect(fs.readFile(restoredContentsPath, "utf8")).resolves.toBe(expectedContents);
      });
    },
  );

  it.runIf(process.platform !== "win32").each([false, true])(
    "backupCreateCommand reports a separately included workspace outside state (relative=%s) through backupRestoreCommand",
    async (relative) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-workspace-link-", scenario: "minimal" },
        async (state) => {
          const workspace = state.path("outside-workspace");
          await fs.mkdir(workspace);
          await fs.writeFile(path.join(workspace, "note.txt"), "workspace content\n");
          await state.writeConfig({ agents: { defaults: { workspace } } });
          const target = path.join(workspace, "note.txt");
          const linkpath = relative ? path.relative(state.stateDir, target) : target;
          await fs.symlink(linkpath, state.statePath("workspace-link"));
          const runtime = createTestRuntime();
          const result = await backupCreateCommand(runtime, {
            output: state.path("backup.tar.gz"),
            verify: true,
          });
          const entries = await listArchiveEntryDetails(result.archivePath);
          const link = expectDefined(
            entries.find((entry) => entry.path.endsWith("/state/workspace-link")),
            "workspace link",
          );
          expect(link).toMatchObject({ type: "SymbolicLink", linkpath });
          const report = [{ entryPath: link.path, linkpath }];
          expect(result.externalSymbolicLinks).toEqual(report);
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(JSON.stringify(linkpath)),
          );
          const restored = state.path("restored");
          const restore = await backupRestoreCommand(runtime, {
            archive: result.archivePath,
            target: restored,
          });
          expect(restore.externalSymbolicLinks).toEqual(report);
          expect(await fs.readlink(path.join(restored, link.path))).toBe(linkpath);
          const workspaceAsset = expectDefined(
            result.assets.find((asset) => asset.kind === "workspace"),
            "workspace asset",
          );
          expect(
            await fs.readFile(path.join(restored, workspaceAsset.archivePath, "note.txt"), "utf8"),
          ).toBe("workspace content\n");
          const manifest = JSON.parse(
            await fs.readFile(path.join(restored, result.archiveRoot, "manifest.json"), "utf8"),
          );
          expect(manifest.externalSymbolicLinks).toEqual(report);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "backupCreateCommand keeps the canonical state boundary when a workspace covers an aliased state directory",
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-state-alias-", scenario: "minimal" },
        async (state) => {
          const workspace = state.path("enclosing-workspace");
          const canonicalState = path.join(workspace, "state");
          await fs.mkdir(canonicalState, { recursive: true });
          const config = path.join(canonicalState, "openclaw.json");
          await fs.writeFile(config, JSON.stringify({ agents: { defaults: { workspace } } }));
          const alias = state.path("state-alias");
          await fs.symlink(canonicalState, alias);
          state.envVars.OPENCLAW_STATE_DIR = alias;
          state.envVars.OPENCLAW_CONFIG_PATH = config;
          state.applyEnv();
          const target = path.join(canonicalState, "note.txt");
          await fs.writeFile(target, "internal content\n");
          await fs.symlink(target, path.join(canonicalState, "internal-link"));
          const result = await backupCreateCommand(createTestRuntime(), {
            output: state.path("backup.tar.gz"),
            verify: true,
          });
          expect(result.assets.map((asset) => asset.kind)).toEqual(["workspace"]);
          expect(result.externalSymbolicLinks).toBeUndefined();
          expect(result.verified).toBe(true);
        },
      );
    },
  );

  it("skips managed absolute runtime symlinks while preserving adjacent state", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBackupState("openclaw-backup-managed-runtime-links-", async (state) => {
      const outputDir = state.path("backups");
      const browserRoot = state.statePath("browser", "openclaw", "user-data");
      const skillsRoot = state.statePath(
        "sandbox",
        "skills-workspaces",
        "workspace-main",
        ".openclaw",
        "sandbox-skills",
        "skills",
      );
      const generatedDbPath = path.join(skillsRoot, "generated.sqlite");
      const durableDbPath = state.statePath("plugins", "dedicated", "durable.sqlite");
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(browserRoot, { recursive: true });
      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.mkdir(path.dirname(durableDbPath), { recursive: true });
      await fs.writeFile(path.join(browserRoot, "Preferences"), "browser state\n", "utf8");
      await state.writeJson("sandbox/registry.json", { active: true });
      createEmptySqliteDatabase(generatedDbPath);
      createEmptySqliteDatabase(durableDbPath);
      await fs.symlink(state.path("chromium-socket"), path.join(browserRoot, "SingletonSocket"));
      await fs.symlink(state.path("project-skill"), path.join(skillsRoot, "project-skill"));

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntries(result.archivePath);

      expectArchivePath(entries, "/state/browser/openclaw/user-data/Preferences", true);
      expectArchivePath(entries, "/state/sandbox/registry.json", true);
      expectArchivePath(entries, "/state/plugins/dedicated/durable.sqlite", true);
      expect(entries.some((entry) => entry.includes("/SingletonSocket"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/sandbox/skills-workspaces/"))).toBe(false);
      const runtime = createTestRuntime();
      await expect(
        backupVerifyCommand(runtime, { archive: result.archivePath }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  it("preserves noncanonical symlinked SQLite paths without dereferencing them", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBackupState("openclaw-backup-symlinked-sqlite-", async (state) => {
      const outputDir = state.path("backups");
      const backingPath = state.statePath("plugins", "backing", "malformed.bin");
      const linkedDbPath = state.statePath("plugins", "dedicated", "linked.sqlite");
      await fs.mkdir(path.dirname(backingPath), { recursive: true });
      await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(backingPath, "not a sqlite database", "utf8");
      await fs.symlink(path.relative(path.dirname(linkedDbPath), backingPath), linkedDbPath);

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntryDetails(result.archivePath);
      expect(
        entries.find((entry) => entry.path.endsWith("/state/plugins/dedicated/linked.sqlite")),
      ).toMatchObject({ type: "SymbolicLink" });
      const runtime = createTestRuntime();
      await expect(backupVerifyCommand(runtime, { archive: result.archivePath })).resolves.toEqual(
        expect.objectContaining({ ok: true, symlinkCount: 1 }),
      );
    });
  });

  it("sanitizes every in-state symlink and hardlink alias of the canonical global SQLite DB", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBackupState("openclaw-backup-global-sqlite-symlink-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const backingDbPath = state.statePath("state", "backing-global.sqlite");
      const linkedDbPath = state.statePath("state", "openclaw.sqlite");
      const hardlinkedDbPath = state.statePath("state", "._hardlinked-global.sqlite");
      await state.writeConfig({
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
        },
      });
      await fs.mkdir(path.dirname(linkedDbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      const sqlite = requireNodeSqlite();
      const transientBlobMarker = `aliased-transient-blob-${"sensitive".repeat(32)}`;
      const db = new sqlite.DatabaseSync(backingDbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE durable_state (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE delivery_queue_entries (
          id TEXT PRIMARY KEY
        );
        CREATE TABLE plugin_blob_entries (
          plugin_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          blob BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        );
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT
        );
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
        VALUES ('primary', 'global', 1, NULL);
        PRAGMA user_version = 1;
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO durable_state (id, value) VALUES (1, 'must-stay');
        INSERT INTO delivery_queue_entries (id) VALUES ('must-drop');
      `);
      db.prepare(
        `INSERT INTO plugin_blob_entries
          (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "diffs",
        "diff-artifacts",
        "transient",
        JSON.stringify({ marker: transientBlobMarker }),
        Buffer.from(transientBlobMarker),
        1,
        Date.UTC(2099, 0, 1),
      );
      await fs.symlink(backingDbPath, linkedDbPath);
      await fs.link(backingDbPath, hardlinkedDbPath);
      expect((await fs.stat(hardlinkedDbPath)).ino).toBe((await fs.stat(backingDbPath)).ino);
      expect((await fs.stat(hardlinkedDbPath)).nlink).toBeGreaterThan(1);
      expect((await fs.stat(`${backingDbPath}-wal`)).size).toBeGreaterThan(0);
      await expect(fs.stat(`${hardlinkedDbPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });

      try {
        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 4, 9, 8, 34, 30),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);
        const archivedDbEntries = entries.filter(
          (entry) =>
            entry.path.endsWith("/state/state/openclaw.sqlite") ||
            entry.path.endsWith("/state/state/backing-global.sqlite") ||
            entry.path.endsWith("/state/state/._hardlinked-global.sqlite"),
        );
        expect(archivedDbEntries).toEqual([
          expect.objectContaining({
            type: "File",
          }),
          expect.objectContaining({
            type: "File",
          }),
          expect.objectContaining({
            type: "File",
          }),
        ]);

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        for (const archivedDbEntry of archivedDbEntries) {
          const archivedPath = path.join(extractDir, archivedDbEntry.path);
          expect((await fs.readFile(archivedPath)).includes(transientBlobMarker)).toBe(false);
          const archivedDb = new sqlite.DatabaseSync(archivedPath, { readOnly: true });
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
            expect(
              archivedDb.prepare("SELECT value FROM durable_state WHERE id = 1").get(),
            ).toEqual({ value: "must-stay" });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
            ).toEqual({ count: 0 });
            expect(
              archivedDb.prepare("SELECT COUNT(*) AS count FROM plugin_blob_entries").get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }
        }

        const runtime = createTestRuntime();
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      } finally {
        db.close();
      }
    });
  });

  it.each([false, true])("backupCreateCommand: private agent DB=%s", async (privateTarget) => {
    if (process.platform === "win32") {
      return;
    }

    await withBackupState("openclaw-backup-agent-sqlite-alias-", async (state) => {
      const outputDir = state.path("backups");
      const extractDir = state.path("extract");
      const agentDir = state.statePath("agents", "main", "agent");
      const backingDir = privateTarget ? state.path("private-agent-db") : agentDir;
      const backingDbPath = path.join(backingDir, "backing-agent.sqlite");
      const linkedDbPath = path.join(agentDir, "openclaw-agent.sqlite");
      const hardlinkedDbPath = state.statePath("plugins", "dedicated", "._agent-alias.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(backingDir, { recursive: true });
      if (privateTarget) {
        await fs.writeFile(
          path.join(backingDir, ".openclaw-private-update-capture"),
          "openclaw-private-update-capture-v1\n",
        );
      }
      await fs.mkdir(path.dirname(hardlinkedDbPath), { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      const sqlite = requireNodeSqlite();
      const db = new sqlite.DatabaseSync(backingDbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY,
          role TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          agent_id TEXT
        );
        CREATE TABLE durable_state (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE state_leases (
          scope TEXT NOT NULL,
          lease_key TEXT NOT NULL
        );
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id)
        VALUES ('primary', 'agent', 1, 'main');
        PRAGMA user_version = 1;
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO durable_state (id, value) VALUES (1, 'committed-in-wal');
        INSERT INTO state_leases (scope, lease_key) VALUES ('core:test-fixture', 'write');
        CREATE TABLE delivery_queue_entries (id TEXT);
        INSERT INTO delivery_queue_entries VALUES ('keep');
        CREATE TABLE plugin_blob_entries (entry_key TEXT, expires_at INTEGER);
        INSERT INTO plugin_blob_entries VALUES ('keep', 1);
      `);
      registerAgentDatabase(state, linkedDbPath);
      await fs.symlink(backingDbPath, linkedDbPath);
      await fs.link(backingDbPath, hardlinkedDbPath);
      expect((await fs.stat(hardlinkedDbPath)).ino).toBe((await fs.stat(backingDbPath)).ino);
      expect((await fs.stat(hardlinkedDbPath)).nlink).toBeGreaterThan(1);
      expect((await fs.stat(`${backingDbPath}-wal`)).size).toBeGreaterThan(0);
      await expect(fs.stat(`${linkedDbPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(`${hardlinkedDbPath}-wal`)).rejects.toMatchObject({
        code: "ENOENT",
      });

      try {
        const create = () =>
          backupCreateCommand(createTestRuntime(), {
            output: outputDir,
            includeWorkspace: false,
            verify: true,
          });
        if (privateTarget) {
          await expect(create()).rejects.toThrow(
            "Private update captures are excluded from backups and support exports.",
          );
          expect(await fs.readdir(outputDir)).toEqual([]);
          expect(db.prepare("SELECT value FROM durable_state WHERE id = 1").get()).toEqual({
            value: "committed-in-wal",
          });
          return;
        }
        const result = await create();
        const entries = await listArchiveEntryDetails(result.archivePath);
        const archivedDbEntries = entries.filter(
          (entry) =>
            entry.path.endsWith("/state/agents/main/agent/openclaw-agent.sqlite") ||
            entry.path.endsWith("/state/agents/main/agent/backing-agent.sqlite") ||
            entry.path.endsWith("/state/plugins/dedicated/._agent-alias.sqlite"),
        );
        expect(archivedDbEntries).toHaveLength(3);
        expect(archivedDbEntries.every((entry) => entry.type === "File")).toBe(true);

        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        for (const archivedDbEntry of archivedDbEntries) {
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, archivedDbEntry.path), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb.prepare("SELECT value FROM durable_state WHERE id = 1").get(),
            ).toEqual({ value: "committed-in-wal" });
            expect(archivedDb.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
              count: 0,
            });
            for (const table of ["delivery_queue_entries", "plugin_blob_entries"]) {
              expect(archivedDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
                count: 1,
              });
            }
          } finally {
            archivedDb.close();
          }
        }

        expect(db.prepare("SELECT COUNT(*) AS count FROM state_leases").get()).toEqual({
          count: 1,
        });
        const runtime = createTestRuntime();
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        db.close();
      }
    });
  });

  it("fails when the canonical global SQLite path is not a file", async () => {
    await withBackupState("openclaw-backup-global-sqlite-directory-", async (state) => {
      const outputDir = state.path("backups");
      const globalDbPath = state.statePath("state", "openclaw.sqlite");
      await fs.mkdir(globalDbPath, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });

      await expect(createStateArchive(outputDir)).rejects.toThrow(
        `Cannot read shared state for discovery: ${globalDbPath}`,
      );
      expect(await fs.readdir(outputDir)).toEqual([]);
    });
  });

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

      const runtime = createTestRuntime();
      const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
      expect(verification.ok).toBe(true);
    });
  });

  it("preserves configured state paths nested under managed runtime roots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-managed-root-workspace-",
        scenario: "minimal",
        env: { OPENCLAW_OAUTH_DIR: undefined },
      },
      async (state) => {
        const stateDir = state.stateDir;
        const workspaceDir = path.join(stateDir, "dev", "workspace");
        const tmpWorkspaceDir = path.join(stateDir, "tmp", "workspace");
        const agentTempRoot = path.join(
          stateDir,
          "agents",
          "main",
          "agent",
          "runtime-home",
          ".tmp",
        );
        const agentTmpWorkspaceDir = path.join(agentTempRoot, "workspace");
        const externalTmpWorkspaceDir = state.path("tmp");
        const configPath = path.join(stateDir, "git", "config", "openclaw.json");
        const oauthDir = path.join(stateDir, "tools", "oauth");
        const workspaceDbPath = path.join(workspaceDir, "workspace.sqlite");
        const outputDir = state.path("backups");
        state.envVars.OPENCLAW_CONFIG_PATH = configPath;
        state.envVars.OPENCLAW_OAUTH_DIR = oauthDir;
        state.applyEnv();
        for (const [relativePath, contents] of [
          ["tools/oauth/credentials.json", "{}\n"],
          ["dev/workspace/AGENTS.md", "durable workspace\n"],
          ["tmp/workspace/AGENTS.md", "durable tmp workspace\n"],
          [
            "agents/main/agent/runtime-home/.tmp/workspace/AGENTS.md",
            "durable agent tmp workspace\n",
          ],
          ["agents/main/agent/runtime-home/.tmp/scratch/cache-entry", "scratch\n"],
          ["tmp/tsx-501/cache-entry", "rebuildable compiler cache\n"],
          ["dev/openclaw/package.json", "{}\n"],
          ["tools/runtime/tool.bin", "runtime\n"],
        ] as const) {
          await state.writeText(relativePath, contents);
        }
        await fs.mkdir(externalTmpWorkspaceDir, { recursive: true });
        await fs.writeFile(
          path.join(externalTmpWorkspaceDir, "AGENTS.md"),
          "durable external tmp workspace\n",
          "utf8",
        );
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            agents: {
              defaults: { systemAgent: { agentId: "main" } },
              entries: {
                main: { workspace: workspaceDir },
                external: { workspace: externalTmpWorkspaceDir },
                worker: { workspace: tmpWorkspaceDir },
                nested: { workspace: agentTmpWorkspaceDir },
              },
            },
          }) + "\n",
        );
        if (process.platform !== "win32") {
          await fs.symlink(
            path.relative(stateDir, path.join(externalTmpWorkspaceDir, "AGENTS.md")),
            path.join(stateDir, "external-workspace-link"),
          );
        }
        const sqlite = requireNodeSqlite();
        const workspaceDb = new sqlite.DatabaseSync(workspaceDbPath);
        try {
          workspaceDb.exec(
            "CREATE TABLE durable_state (value TEXT NOT NULL); INSERT INTO durable_state VALUES ('keep');",
          );
        } finally {
          workspaceDb.close();
        }
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
        expect(
          entries.some((entry) =>
            entry.endsWith("/state/agents/main/agent/runtime-home/.tmp/workspace/AGENTS.md"),
          ),
        ).toBe(true);
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

        const runtime = createTestRuntime();
        await expect(
          backupVerifyCommand(runtime, { archive: result.archivePath }),
        ).resolves.toMatchObject({ ok: true });
      },
    );
  });

  it("dereferences hardlinks instead of emitting restore-hostile Link entries", async () => {
    await withBackupState("openclaw-backup-hardlink-", async (state) => {
      const stateDir = state.stateDir;
      const outputDir = state.path("backups");
      const sourcePath = path.join(stateDir, "workspace-adx", "openclaw-src", "node_modules");
      const targetPath = path.join(sourcePath, "esbuild", "bin", "esbuild");
      const hardlinkPath = path.join(sourcePath, "@esbuild", "darwin-arm64", "bin", "esbuild");
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.mkdir(path.dirname(hardlinkPath), { recursive: true });
      await fs.writeFile(targetPath, "binary fixture\n", "utf8");
      await fs.link(targetPath, hardlinkPath);
      await fs.mkdir(outputDir, { recursive: true });

      const result = await createStateArchive(outputDir);
      const entries = await listArchiveEntryDetails(result.archivePath);

      expect(entries.filter((entry) => entry.type === "Link")).toStrictEqual([]);
      expect(entries.some((entry) => entry.path.endsWith("/esbuild/bin/esbuild"))).toBe(true);
      expect(
        entries.some((entry) => entry.path.endsWith("/@esbuild/darwin-arm64/bin/esbuild")),
      ).toBe(true);

      const runtime = createTestRuntime();
      const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
      expect(verification.ok).toBe(true);
    });
  });

  it.each(["nested", "equal"])(
    "keeps one manifest when the tempdir is %s to state",
    async (placement) => {
      await withBackupState("openclaw-backup-tmp-equals-state-", async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        const emptyDbPath = state.statePath("plugins", "dedicated", "empty.sqlite");
        const extractDir = state.path("extract");
        await fs.mkdir(path.dirname(emptyDbPath), { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.writeFile(emptyDbPath, "");
        const tempDir = placement === "nested" ? state.statePath("tmp") : state.stateDir;
        await fs.mkdir(tempDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(tempDir);

        try {
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

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(
            path.join(
              extractDir,
              expectDefined(emptyDbEntries[0], "emptyDbEntries[0] test invariant"),
            ),
            {
              readOnly: true,
            },
          );
          try {
            expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
              integrity_check: "ok",
            });
          } finally {
            archivedDb.close();
          }

          const runtime = createTestRuntime();
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
