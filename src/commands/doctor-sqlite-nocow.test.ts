import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { createClientCredentialMigrationFixture } from "../infra/client-credential-migration.test-support.js";
import { runClientCredentialOperation } from "../infra/client-credential-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { readSqliteReaderDiagnosticsForPath } from "../infra/sqlite-reader-lifecycle.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { isSqlitePathOnBtrfs } from "../infra/sqlite-wal-filesystem.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { completeDoctorMigrationBackups } from "./doctor-migration-backup-artifacts.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { inspectDoctorSqliteNoCow, repairDoctorSqliteNoCow } from "./doctor-sqlite-nocow.js";
import {
  baseAcl,
  inheritedDefaultAcl,
  createDoctorNoCowToolFixture,
} from "./doctor-sqlite-nocow.test-support.js";
import * as updateCaptureCleanup from "./update-capture-cleanup.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
vi.mock("../infra/sqlite-wal-filesystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-wal-filesystem.js")>()),
  isSqlitePathOnBtrfs: vi.fn(() => true),
  setSqliteDirectoryNoCow: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let directory: string;
let sqlitePath: string;
let fixture: ReturnType<typeof createDoctorNoCowToolFixture>;
const nativeStatfs = fs.statfsSync;

beforeEach(() => {
  root = tempDirs.make("openclaw-nocow-");
  directory = path.join(root, "state");
  fs.mkdirSync(directory);
  sqlitePath = path.join(directory, "openclaw.sqlite");
  fixture = createDoctorNoCowToolFixture(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function seedDatabase() {
  const seedPath = path.join(root, "seed.sqlite");
  {
    using db = openNodeSqliteDatabase(seedPath);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('in the WAL');",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.copyFileSync(`${seedPath}${suffix}`, `${sqlitePath}${suffix}`);
    }
  }
  fs.chmodSync(sqlitePath, 0o640);
  fs.chmodSync(directory, 0o750);
  fs.writeFileSync(path.join(directory, "sibling.txt"), "preserve me");
}

function rewrite(
  assertCurrent = () => {},
  overrides: Partial<Parameters<typeof repairDoctorSqliteNoCow>[0]> = {},
) {
  return repairDoctorSqliteNoCow({
    paths: [sqlitePath],
    stateDir: root,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
    assertCurrent,
    ...overrides,
  });
}

function replaceDatabase(pathname: string) {
  const replacement = path.join(root, "replacement.sqlite");
  fs.copyFileSync(pathname, replacement);
  fs.renameSync(replacement, pathname);
}

async function repair(assertCurrent = () => {}) {
  const result = await rewrite(assertCurrent);
  return [...result.changes, ...result.warnings].join("\n");
}

async function useNativeTools(useNative: (command: string) => boolean) {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const tools = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((command, args, options) =>
    useNative(command) ? native.spawnSync(command, args, options) : tools(command, args, options),
  );
}

function expectDatabaseValue(pathname: string, table: string, value: string) {
  using database = openNodeSqliteDatabase(pathname, { readOnly: true });
  expect({
    value: database.prepare(`SELECT value FROM ${table}`).get()?.value,
    integrity: database.prepare("PRAGMA quick_check").get()?.quick_check,
  }).toEqual({ value, integrity: "ok" });
}

it.each([
  ["fuser", "fuser cannot inspect processes"],
  ["mv", "kernel/filesystem lacks RENAME_EXCHANGE"],
])("refuses unsupported %s before inventory and copies", async (command, limit) => {
  seedDatabase();
  const original = fs.statSync(directory).ino;
  const tool = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((name, args, options) =>
    name === command
      ? { status: 1, stdout: "", stderr: "unsupported", pid: 0, output: [], signal: null }
      : tool(name, args, options),
  );
  const inventory = vi.spyOn(fs, "readdirSync");
  const copy = vi.spyOn(fsp, "open");
  expect(await repair()).toContain(limit);
  expect(vi.mocked(spawnSync).mock.calls.some(([name]) => name === "getfacl")).toBe(false);
  expect(inventory.mock.calls.some(([pathname]) => pathname === directory)).toBe(false);
  expect(copy).not.toHaveBeenCalled();
  expect(fs.statSync(directory).ino).toBe(original);
  expect(fs.readdirSync(root).some((name) => name.includes(".nocow-"))).toBe(false);
});

it("refuses a store opened after copying before the real exchange", async () => {
  seedDatabase();
  const original = fs.statSync(directory).ino;
  let inspections = 0;
  const tool = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((command, args, options) =>
    command === "fuser" && args?.includes(sqlitePath) && ++inspections === 2
      ? { status: 0, stdout: "12345", stderr: "", pid: 0, output: [], signal: null }
      : tool(command, args, options),
  );
  expect(await repair()).toContain("store files are open (pids: 12345)");
  expect(fs.statSync(directory).ino).toBe(original);
  expect(fixture.exchanges).toBe(0);
});

it.skipIf(process.platform !== "linux")(
  "rewrites shared and agent stores after Doctor drains native and admission descriptors",
  async () => {
    await withOpenClawTestState(
      { scenario: "external-service", label: "doctor-nocow-owner" },
      async () => {
        await useNativeTools(
          (command) => !["lsattr", "getfacl", "setfacl", "mv"].includes(command),
        );
        const maintenance = await beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true, workspaceSuggestions: false },
          root: null,
          runtime: { log() {}, error() {}, exit() {} },
        });
        try {
          const paths = await maintenance!.run(async () => {
            const state = openOpenClawStateDatabase();
            const agents = ["main", "secondary", "unconfigured"].map((agentId) =>
              openOpenClawAgentDatabase({ agentId }),
            );
            for (const agent of agents) {
              loadPersistedAuthProfileStore(path.dirname(agent.path));
            }
            const preflight = await prepareDoctorDatabasePreflight({
              cfg: { agents: { entries: { main: {}, secondary: {} } } },
            });
            expect(preflight.agentDatabaseMigrationDiscovery?.discovery.targets).toHaveLength(3);
            return inspectDoctorSqliteNoCow([state.path, ...agents.map((agent) => agent.path)])
              .paths;
          });
          expect(paths).toHaveLength(4);
          const handleCounts: number[] = [];
          const toolRunner = vi.mocked(spawnSync).getMockImplementation()!;
          vi.mocked(spawnSync).mockImplementation((command, args, options) => {
            if (command === "fuser") {
              for (const pathname of paths) {
                handleCounts.push(readSqliteReaderDiagnosticsForPath(pathname).connectionCount);
              }
            }
            return toolRunner(command, args, options);
          });
          const originals = paths.map((pathname) => fs.statSync(pathname).ino);
          await maintenance!.repairSqliteNoCow(paths);
          expect(maintenance!.warnings).toEqual([]);
          expect(handleCounts.length).toBeGreaterThan(0);
          expect(handleCounts.every((count) => count === 0)).toBe(true);
          expect(
            paths.every((pathname, index) => fs.statSync(pathname).ino !== originals[index]),
          ).toBe(true);
        } finally {
          await maintenance?.release();
        }
      },
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps admission descriptors when an unknown native handle blocks NOCOW repair",
  async () => {
    seedDatabase();
    {
      using admitted = openNodeSqliteDatabase(sqlitePath);
      admitSqliteSchema(admitted);
    }
    using unknown = new DatabaseSync(sqlitePath);
    unknown.exec("BEGIN IMMEDIATE");
    const identity = fs.statSync(sqlitePath);
    const sourceDescriptors = () =>
      fs
        .readdirSync("/proc/self/fd")
        .flatMap((entry) => {
          try {
            const descriptor = Number(entry);
            const file = fs.fstatSync(descriptor);
            return file.dev === identity.dev && file.ino === identity.ino ? [descriptor] : [];
          } catch {
            return [];
          }
        })
        .toSorted((left, right) => left - right);
    const descriptors = sourceDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(2);
    await useNativeTools((command) => command === "fuser");
    expect(await repair()).toContain("store files are open");
    expect(sourceDescriptors()).toEqual(descriptors);
    expect(unknown.isTransaction).toBe(true);
    expect(fs.statSync(sqlitePath).ino).toBe(identity.ino);
    expect(fixture.exchanges).toBe(0);
  },
);

it("reports existing CoW stores, skips other filesystems and explains missing tooling", () => {
  fs.writeFileSync(sqlitePath, "fixture");
  expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([sqlitePath]);
  fixture.attributes = true;
  expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([]);
  vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(false);
  fixture.tools = "unavailable";
  expect(inspectDoctorSqliteNoCow([sqlitePath]).notes).toEqual([]);
  vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(true);
  expect(inspectDoctorSqliteNoCow([sqlitePath]).notes.join(",")).toContain("lsattr is unavailable");
});

it.each(["exchange-timeout", "different-owner"] as const)(
  "preserves WAL rows, siblings, metadata and original identity with %s",
  async (outcome) => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    const originalDirectory = fs.statSync(directory);
    const nested = path.join(directory, "codex-home");
    fs.mkdirSync(nested);
    for (let index = 0; index < 64; index++) {
      fs.writeFileSync(path.join(nested, `${index}.txt`), "unrelated");
    }
    const sibling = path.join(nested, "0.txt");
    const siblingInode = fs.statSync(sibling).ino;
    if (outcome === "exchange-timeout") {
      fixture.tools = outcome;
    } else {
      const stat = fs.statSync;
      vi.spyOn(fs, "statSync").mockImplementation((pathname, options) => {
        const value = stat(pathname, options);
        if (value && String(pathname).includes(".nocow-backup-") && typeof value.uid === "number") {
          return Object.assign(value, { uid: value.uid + 1 });
        }
        return value;
      });
    }
    const chown = vi.spyOn(fs, "chownSync");
    const chmod = vi.spyOn(fs, "chmodSync");
    expect(await repair()).toContain("Rewrote SQLite files with NOCOW");
    expect(fs.statSync(sqlitePath).ino).not.toBe(original.ino);
    expect(fs.statSync(sqlitePath).mode).toBe(original.mode);
    expect(fs.statSync(directory).mode).toBe(originalDirectory.mode);
    expect(fs.statSync(directory).ino).toBe(originalDirectory.ino);
    expect(fs.statSync(sibling).ino).toBe(siblingInode);
    expect(
      vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "getfacl").length,
    ).toBeLessThanOrEqual(2);
    const backup = fs.readdirSync(root).find((name) => name.startsWith("state.nocow-backup-"))!;
    expect(fs.statSync(path.join(root, backup, "openclaw.sqlite")).ino).toBe(original.ino);
    expect(fs.readFileSync(path.join(directory, "sibling.txt"), "utf8")).toBe("preserve me");
    expectDatabaseValue(sqlitePath, "payload", "in the WAL");
    if (outcome === "different-owner") {
      const targetCall = chown.mock.calls.findIndex(([pathname]) =>
        String(pathname).endsWith("openclaw.sqlite"),
      );
      expect(targetCall).toBeGreaterThanOrEqual(0);
      const target = chown.mock.calls[targetCall]?.[0];
      expect(chown.mock.calls[targetCall]).toEqual([target, original.uid, original.gid]);
      const modeCall = chmod.mock.calls.findIndex(([pathname]) => pathname === target);
      expect(chown.mock.invocationCallOrder[targetCall]).toBeLessThan(
        chmod.mock.invocationCallOrder[modeCall]!,
      );
    }
  },
);

it.skipIf(process.platform === "win32")(
  "leaves unrelated nested symlinks and lock files outside the rewrite",
  async () => {
    seedDatabase();
    const nested = path.join(directory, "tmp", "arg0");
    fs.mkdirSync(nested, { recursive: true });
    const external = path.join(root, "external");
    fs.writeFileSync(external, "outside the store");
    const link = path.join(nested, "unrelated.sqlite");
    fs.symlinkSync(external, link);
    const lock = path.join(nested, ".lock");
    fs.writeFileSync(lock, "");
    const originalLink = fs.lstatSync(link);
    const originalLock = fs.lstatSync(lock);
    const tool = vi.mocked(spawnSync).getMockImplementation()!;
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      if (command === "fuser" && !args?.[0]?.includes(".nocow-probe-")) {
        expect(args).not.toContain(lock);
        expect(args).not.toContain(link);
        expect(args).not.toContain(external);
      }
      return tool(command, args, options);
    });
    expect(await repair()).toContain("Rewrote SQLite files with NOCOW");
    expect(fs.lstatSync(link)).toMatchObject(originalLink);
    expect(fs.readlinkSync(link)).toBe(external);
    expect(fs.lstatSync(lock)).toMatchObject(originalLock);
    expect(fs.readFileSync(lock)).toHaveLength(0);
    expect(fs.readFileSync(external, "utf8")).toBe("outside the store");
  },
);

it.skipIf(process.platform === "win32").each(["access", "default", "denied-grant"] as const)(
  "preserves source %s ACLs without exposing inherited grants",
  async (kind) => {
    seedDatabase();
    const fileAcl = "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---";
    const directoryAcl =
      kind === "default"
        ? `${baseAcl}\n${inheritedDefaultAcl}`
        : kind === "denied-grant"
          ? "user::rwx\nuser:12345:---\ngroup::r-x\nmask::r-x\nother::---"
          : baseAcl;
    fixture.acls.set(directory, directoryAcl);
    if (kind !== "denied-grant") {
      fixture.acls.set(sqlitePath, fileAcl);
    }
    const originalMode = fs.statSync(directory).mode;
    expect(await repair()).toContain("Rewrote");
    expect(fs.statSync(directory).mode).toBe(originalMode);
    expect(fixture.acls.get(directory)).toBe(directoryAcl);
    if (kind !== "denied-grant") {
      const stagedFile = [...fixture.acls.keys()].find(
        (pathname) => pathname.includes(".nocow-backup-") && pathname.endsWith("openclaw.sqlite"),
      )!;
      expect(fixture.acls.get(stagedFile)).toBe(fileAcl);
    }
  },
);

it.each([
  [
    "spawnSync fuser ENOENT",
    { error: Object.assign(new Error("spawnSync fuser ENOENT"), { code: "ENOENT" }) },
  ],
  ["exit status 2", { status: 2 }],
  ["signal SIGTERM", { signal: "SIGTERM" }],
] as const)("refuses uncertain SQLite handles with %s", async (detail, result) => {
  seedDatabase();
  const original = fs.statSync(sqlitePath);
  fixture.fuserResult = {
    pid: 0,
    output: [],
    signal: null,
    status: null,
    stdout: "",
    stderr: "",
    ...result,
  };
  expect(await repair()).toContain(
    `fuser could not establish that all handles are closed: ${detail}`,
  );
  expect(fixture.exchanges).toBe(0);
  expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
});

it.each([false, true])(
  "cleans interrupted copies and resumes after checkpoint=%s",
  async (checkpoint) => {
    seedDatabase();
    const unknown = `${directory}.nocow-backup-unknown`;
    fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, "keep"), "unknown data");
    let attempted = 0;
    fixture.beforeExchange = () => {
      if (++attempted === 2) {
        throw new Error("interrupted");
      }
    };
    await expect(repair()).rejects.toThrow("publication needs inspection");
    const installed = fs.statSync(sqlitePath).ino;
    if (checkpoint) {
      const checkpointed = openNodeSqliteDatabase(sqlitePath);
      checkpointed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      checkpointed.close();
      fs.rmSync(`${sqlitePath}-wal`, { force: true });
      fs.rmSync(`${sqlitePath}-shm`, { force: true });
    }
    expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([sqlitePath]);
    const interrupted = fs
      .readdirSync(root)
      .find((name) => name.startsWith("state.nocow-backup-") && !name.endsWith("unknown"))!;
    const retained = path.join(root, interrupted, "openclaw.sqlite");
    const original = fs.statSync(retained).ino;
    fixture.beforeExchange = undefined;
    const progress = vi.fn();
    const result = await rewrite(undefined, {
      env: { OPENCLAW_STATE_DIR: root },
      log: progress,
    });
    expect(result.warnings).toEqual([]);
    expect(fs.statSync(sqlitePath).ino).toBe(installed);
    expect(fs.statSync(retained).ino).toBe(original);
    expect(fs.existsSync(path.join(root, interrupted, "openclaw.sqlite-wal"))).toBe(false);
    expect(fs.readFileSync(path.join(unknown, "keep"), "utf8")).toBe("unknown data");
    if (!checkpoint) {
      expect(progress.mock.calls.some(([message]) => message.includes("(0/2)"))).toBe(true);
    }
    expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([]);
    expectDatabaseValue(sqlitePath, "payload", "in the WAL");
  },
);

it.each(["database", "sidecar"])("refuses an aliased %s before mutation", async (kind) => {
  seedDatabase();
  const source = kind === "database" ? sqlitePath : `${sqlitePath}-wal`;
  fs.linkSync(source, path.join(root, "alias"));
  expect(await repair()).toContain("hard-linked path");
  expect(fixture.exchanges).toBe(0);
});

it.each([
  "space",
  "getfacl",
  "setfacl",
  "verification",
  "unavailable",
  "authority",
  "corrupt",
  "exchange-failed",
] as const)("leaves the previous store intact on %s refusal", async (failure) => {
  seedDatabase();
  const original = fs.statSync(sqlitePath);
  if (failure === "space") {
    vi.mocked(fs.statfsSync).mockReturnValue({
      ...nativeStatfs(root, { bigint: true }),
      bavail: 0n,
    });
  }
  if (failure === "unavailable" || failure === "exchange-failed") {
    fixture.tools = failure;
  }
  if (failure === "corrupt") {
    fs.unlinkSync(`${sqlitePath}-wal`);
    fs.unlinkSync(`${sqlitePath}-shm`);
    fs.writeFileSync(sqlitePath, "not a database");
  }
  if (failure === "getfacl" || failure === "setfacl") {
    fixture.unavailableAclTool = failure;
  }
  if (failure === "verification") {
    fixture.acls.set(sqlitePath, "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---");
    fixture.rejectAclVerification = true;
  }
  const notes = await repair(() => {
    if (failure === "authority") {
      throw new Error("Gateway owns the store");
    }
  });
  expect(notes).not.toContain("Rewrote");
  expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
  expect(fixture.exchanges).toBe(failure === "exchange-failed" ? 1 : 0);
  expect(notes).toMatch(
    failure === "getfacl" || failure === "setfacl" || failure === "verification"
      ? /skipped/u
      : /refused|skipped/u,
  );
  expect(fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-backup-"))).toEqual([]);
  if (failure === "corrupt") {
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-snapshots-")),
    ).toEqual([]);
  }
});

describe("Doctor NOCOW recovery identities", () => {
  let env: NodeJS.ProcessEnv;

  function readTarget() {
    return readSessionSqliteMigrationManifest(listSessionSqliteMigrationManifestPaths(env)[0]!)!
      .targets[0]!;
  }

  async function prepareCompletedBackup() {
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await maintenance.run(async () => {
        await backupDoctorMigrationDatabases({
          env,
          pendingDatabasePaths: [sqlitePath],
          databasePaths: [sqlitePath],
        });
        completeDoctorMigrationBackups(env, [sqlitePath]);
      });
    } finally {
      await maintenance.close();
    }
    return readTarget().plannedMoves[0]!.archivePath;
  }

  function retire() {
    return retireSessionSqliteRecovery({
      env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
  }

  beforeEach(async () => {
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    using database = new DatabaseSync(sqlitePath);
    database.exec(
      "PRAGMA user_version = 1; CREATE TABLE preserved (value TEXT NOT NULL); INSERT INTO preserved VALUES ('before migration');",
    );
    await useNativeTools((command) => command === process.execPath);
    // Only the later-update gate is synthetic; backup, rewrite and retirement stay real.
    vi.spyOn(updateCaptureCleanup, "readCompletedUpdateHistory").mockReturnValue({
      runs: [],
      latestCompletedStartedAt: Date.now() + 86_400_000,
      latestVerifiedStartedAt: 0,
      hasPendingRecovery: false,
    });
  });

  it.each([false, true])(
    "preserves migrated credentials only for the rewritten generation (replaced beforehand: %s)",
    async (replaced) => {
      fs.rmSync(sqlitePath);
      const credentials = await createClientCredentialMigrationFixture(root);
      try {
        credentials.migrate(() =>
          credentials.source.exec(
            "UPDATE schema_meta SET schema_version=29; PRAGMA user_version=29;",
          ),
        );
      } finally {
        credentials.source.close();
        await credentials.maintenance.close();
      }
      const readToken = () =>
        runClientCredentialOperation(env, {
          kind: "token.read",
          key: { device_id: credentials.identity.deviceId, role: "v2.gateway.operator" },
        });
      expect(readToken()).toMatchObject({
        kind: "token",
        token: { token: "token-original", scopes_json: '["operator.read"]' },
      });
      if (replaced) {
        replaceDatabase(sqlitePath);
      }
      const rewritten = await rewrite();
      expect(rewritten.changes).toHaveLength(1);
      if (replaced) {
        expect(rewritten.warnings.join("\n")).toContain("recorded generation");
        expect(readToken).toThrow("migration is incomplete or stale");
      } else {
        expect(rewritten.warnings).toEqual([]);
        expect(readToken()).toMatchObject({
          kind: "token",
          token: { token: "token-original", scopes_json: '["operator.read"]' },
        });
      }
    },
  );

  it.each(["unchanged", "destination", "backup", "backup metadata"])(
    "retires only the recorded recovery original after rewrite: %s",
    async (change) => {
      const backupPath = await prepareCompletedBackup();
      const recorded = readTarget();
      const original = fs.readFileSync(backupPath);
      if (change === "destination" || change === "backup") {
        replaceDatabase(change === "destination" ? sqlitePath : backupPath);
      } else if (change === "backup metadata") {
        const touched = new Date("2030-01-01T00:00:00Z");
        fs.utimesSync(backupPath, touched, touched);
      }
      const rewritten = await rewrite();
      expect(rewritten.changes).toHaveLength(1);
      if (change === "destination") {
        expect(rewritten.warnings.join("\n")).toContain("left unchanged");
      } else {
        expect(rewritten.warnings).toEqual([]);
      }
      if (change === "unchanged") {
        expect(String(fs.lstatSync(backupPath, { bigint: true }).ino)).toBe(
          recorded.plannedMoves[0]!.artifact!.identity.ino,
        );
        expect(fs.readFileSync(backupPath)).toEqual(original);
      }
      if (change === "destination") {
        expect(readTarget().databaseIdentity).toEqual(recorded.databaseIdentity);
      } else {
        expect(readTarget().plannedMoves[0]!.artifact!.identity).toEqual(
          recorded.plannedMoves[0]!.artifact!.identity,
        );
      }
      const result = await retire();
      expect(result.artifacts.find((item) => item.path === backupPath)).toMatchObject({
        outcome: change === "unchanged" ? "removed" : "blocked",
        reason:
          change === "unchanged"
            ? "rollback-original-retired"
            : change === "destination"
              ? "destination-verification-failed"
              : "artifact-metadata-changed",
      });
      expect(fs.existsSync(backupPath)).toBe(change !== "unchanged");
      if (change === "unchanged") {
        expectDatabaseValue(sqlitePath, "preserved", "before migration");
      }
    },
  );
});
