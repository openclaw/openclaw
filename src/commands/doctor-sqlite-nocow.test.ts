import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteReaderDiagnosticsForPath } from "../infra/sqlite-reader-lifecycle.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { isSqlitePathOnBtrfs } from "../infra/sqlite-wal-filesystem.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { inspectDoctorSqliteNoCow, repairDoctorSqliteNoCow } from "./doctor-sqlite-nocow.js";
import {
  baseAcl,
  inheritedDefaultAcl,
  createDoctorNoCowToolFixture,
} from "./doctor-sqlite-nocow.test-support.js";

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
  // The real socket fixture must fit sockaddr_un even with a deeply nested TMPDIR.
  root = tempDirs.make("openclaw-nocow-", process.platform === "win32" ? undefined : "/tmp");
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
  const db = openNodeSqliteDatabase(seedPath);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('in the WAL');",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.copyFileSync(`${seedPath}${suffix}`, `${sqlitePath}${suffix}`);
    }
  } finally {
    db.close();
  }
  fs.chmodSync(sqlitePath, 0o640);
  fs.chmodSync(directory, 0o750);
  fs.writeFileSync(path.join(directory, "sibling.txt"), "preserve me");
}

async function repair(assertCurrent = () => {}) {
  const result = await repairDoctorSqliteNoCow({
    paths: [sqlitePath],
    stateDir: root,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
    assertCurrent,
  });
  return [...result.changes, ...result.warnings];
}

describe("Doctor btrfs NOCOW", () => {
  it("leaves unrelated trees and their inodes untouched with bounded ACL work", async () => {
    seedDatabase();
    const nested = path.join(directory, "codex-home");
    fs.mkdirSync(nested);
    for (let index = 0; index < 64; index++) {
      fs.writeFileSync(path.join(nested, `${index}.txt`), "unrelated");
    }
    const sibling = path.join(nested, "0.txt");
    const original = fs.statSync(sibling);
    const originalDirectory = fs.statSync(directory);
    expect((await repair()).join("\n")).toContain("Rewrote");
    expect(fs.statSync(sibling).ino).toBe(original.ino);
    expect(fs.statSync(directory).ino).toBe(originalDirectory.ino);
    expect(
      vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "getfacl").length,
    ).toBeLessThanOrEqual(2);
  });

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
    expect((await repair()).join("\n")).toContain(limit);
    expect(vi.mocked(spawnSync).mock.calls.some(([name]) => name === "getfacl")).toBe(false);
    expect(inventory.mock.calls.some(([pathname]) => pathname === directory)).toBe(false);
    expect(copy).not.toHaveBeenCalled();
    expect(fs.statSync(directory).ino).toBe(original);
    expect(fs.readdirSync(root).some((name) => name.includes(".nocow-"))).toBe(false);
  });

  it("preflights sibling stores on one filesystem once", async () => {
    seedDatabase();
    const sibling = path.join(root, "agent");
    fs.cpSync(directory, sibling, { recursive: true });
    const result = await repairDoctorSqliteNoCow({
      paths: [sqlitePath, path.join(sibling, "openclaw.sqlite")],
      stateDir: root,
      env: { OPENCLAW_STATE_DIR: root },
      assertCurrent: () => {},
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    const probes = vi
      .mocked(spawnSync)
      .mock.calls.filter(
        ([command, args]) => command === "fuser" && args?.[0]?.includes(".nocow-probe-"),
      );
    expect(probes).toHaveLength(1);
    expect(fixture.exchanges).toBe(6);
  });

  it("refuses a store opened after copying before the real exchange", async () => {
    seedDatabase();
    const original = fs.statSync(directory).ino;
    const tool = vi.mocked(spawnSync).getMockImplementation()!;
    let inspections = 0;
    vi.mocked(spawnSync).mockImplementation((command, args, options) =>
      command === "fuser" && args?.includes(sqlitePath) && ++inspections === 2
        ? { status: 0, stdout: "12345", stderr: "", pid: 0, output: [], signal: null }
        : tool(command, args, options),
    );
    expect((await repair()).join("\n")).toContain("store files are open (pids: 12345)");
    expect(fs.statSync(directory).ino).toBe(original);
    expect(fixture.exchanges).toBe(0);
  });

  it.skipIf(process.platform !== "linux")(
    "rewrites shared and agent stores after Doctor drains native and admission descriptors",
    async () => {
      await withOpenClawTestState(
        { scenario: "external-service", label: "doctor-nocow-owner" },
        async () => {
          const native =
            await vi.importActual<typeof import("node:child_process")>("node:child_process");
          const fakeTools = vi.mocked(spawnSync).getMockImplementation()!;
          vi.mocked(spawnSync).mockImplementation((command, args, options) =>
            ["lsattr", "getfacl", "setfacl", "mv"].includes(command)
              ? fakeTools(command, args, options)
              : native.spawnSync(command, args, options),
          );
          const log = vi.fn();
          const maintenance = await beginDoctorMaintenance({
            options: { repair: true, nonInteractive: true, workspaceSuggestions: false },
            root: null,
            runtime: { log, error() {}, exit() {} },
          });
          try {
            const paths = await maintenance!.run(async () => {
              const state = openOpenClawStateDatabase();
              const agents = ["main", "secondary", "unconfigured"].map((agentId) =>
                openOpenClawAgentDatabase({ agentId }),
              );
              for (const database of [state, ...agents]) {
                database.db.exec(
                  "CREATE TABLE nocow_payload(value TEXT); INSERT INTO nocow_payload VALUES ('preserved');",
                );
              }
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
            const toolRunner = vi.mocked(spawnSync).getMockImplementation()!;
            const handleCounts: number[] = [];
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
            expect(fixture.exchanges).toBeGreaterThanOrEqual(4);
            expect(handleCounts.length).toBeGreaterThan(0);
            expect(handleCounts.every((count) => count === 0)).toBe(true);
            for (const [index, pathname] of paths.entries()) {
              expect(fs.statSync(pathname).ino).not.toBe(originals[index]);
              const storeDir = path.dirname(pathname);
              const parent = path.dirname(storeDir);
              const retained = fs
                .readdirSync(parent)
                .find((name) => name.startsWith(`${path.basename(storeDir)}.nocow-backup-`))!;
              expect(fs.statSync(path.join(parent, retained, path.basename(pathname))).ino).toBe(
                originals[index],
              );
              const db = openNodeSqliteDatabase(pathname, { readOnly: true });
              try {
                expect(db.prepare("SELECT value FROM nocow_payload").get()?.value).toBe(
                  "preserved",
                );
                expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
              } finally {
                db.close();
              }
            }
            expect(
              log.mock.calls.filter(([line]) => line.startsWith("Rewrote SQLite files")),
            ).toHaveLength(4);
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
      const admitted = openNodeSqliteDatabase(sqlitePath);
      try {
        admitSqliteSchema(admitted);
      } finally {
        admitted.close();
      }
      const unknown = new DatabaseSync(sqlitePath);
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
      const native =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const fakeTools = vi.mocked(spawnSync).getMockImplementation()!;
      vi.mocked(spawnSync).mockImplementation((command, args, options) =>
        command === "fuser"
          ? native.spawnSync(command, args, options)
          : fakeTools(command, args, options),
      );
      try {
        expect((await repair()).join("\n")).toContain("store files are open");
        expect(sourceDescriptors()).toEqual(descriptors);
        expect(unknown.isTransaction).toBe(true);
        expect(fs.statSync(sqlitePath).ino).toBe(identity.ino);
        expect(fixture.exchanges).toBe(0);
      } finally {
        unknown.exec("ROLLBACK");
        unknown.close();
      }
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
    expect(inspectDoctorSqliteNoCow([sqlitePath]).notes.join(",")).toContain(
      "lsattr is unavailable",
    );
  });

  it.each(["exchange-timeout", "different-owner"] as const)(
    "preserves WAL rows, siblings, metadata and original identity with %s",
    async (outcome) => {
      seedDatabase();
      const original = fs.statSync(sqlitePath);
      const originalDirectory = fs.statSync(directory);
      if (outcome === "exchange-timeout") {
        fixture.tools = outcome;
      } else {
        const stat = fs.statSync;
        vi.spyOn(fs, "statSync").mockImplementation((pathname, options) => {
          const value = stat(pathname, options);
          if (
            value &&
            String(pathname).includes(".nocow-backup-") &&
            typeof value.uid === "number"
          ) {
            return Object.assign(value, { uid: value.uid + 1 });
          }
          return value;
        });
      }
      const chown = vi.spyOn(fs, "chownSync");
      const chmod = vi.spyOn(fs, "chmodSync");
      expect((await repair()).join(",")).toContain("Rewrote SQLite files with NOCOW");
      expect(fixture.exchanges).toBe(3);
      expect(fs.statSync(sqlitePath).ino).not.toBe(original.ino);
      expect(fs.statSync(sqlitePath).mode).toBe(original.mode);
      expect(fs.statSync(directory).mode).toBe(originalDirectory.mode);
      const backup = fs.readdirSync(root).find((name) => name.startsWith("state.nocow-backup-"))!;
      expect(fs.statSync(path.join(root, backup, "openclaw.sqlite")).ino).toBe(original.ino);
      expect(fs.readFileSync(path.join(directory, "sibling.txt"), "utf8")).toBe("preserve me");
      const db = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM payload").get()?.value).toBe("in the WAL");
        expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      } finally {
        db.close();
      }
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
    "preserves nested symlink bytes and empty lock files without following targets",
    async () => {
      seedDatabase();
      const nested = path.join(directory, "tmp", "arg0");
      fs.mkdirSync(nested, { recursive: true });
      const external = path.join(root, "external");
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, "untouched"), "outside the store");
      const links = new Map([
        [path.join(nested, "absolute"), Buffer.from(external)],
        [path.join(nested, "relative"), Buffer.from("../../sibling.txt")],
        [path.join(nested, "dangling.sqlite"), Buffer.from("missing-target")],
        [path.join(nested, "raw-bytes"), Buffer.from([0x66, 0x80, 0xff])],
      ]);
      for (const [pathname, target] of links) {
        fs.symlinkSync(target, pathname);
      }
      const owners = [...links.keys()].map((pathname) => fs.lstatSync(pathname));
      const lock = path.join(nested, ".lock");
      fs.writeFileSync(lock, "");
      const originalLock = fs.statSync(lock);
      const tool = vi.mocked(spawnSync).getMockImplementation()!;
      vi.mocked(spawnSync).mockImplementation((command, args, options) => {
        if (command === "fuser" && !args?.[0]?.includes(".nocow-probe-")) {
          expect(args).not.toContain(lock);
          for (const pathname of args ?? []) {
            expect(fs.lstatSync(pathname).isSymbolicLink()).toBe(false);
            expect(pathname.startsWith(external)).toBe(false);
          }
        }
        return tool(command, args, options);
      });

      expect((await repair()).join("\n")).toContain("Rewrote SQLite files with NOCOW");
      expect(fixture.exchanges).toBe(3);
      for (const [index, [pathname, target]] of [...links].entries()) {
        const stat = fs.lstatSync(pathname);
        expect(stat.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(pathname, { encoding: "buffer" })).toEqual(target);
        expect([stat.uid, stat.gid]).toEqual([owners[index]!.uid, owners[index]!.gid]);
      }
      expect(fs.existsSync(path.join(nested, "dangling.sqlite"))).toBe(false);
      expect(fs.statSync(lock).isFile()).toBe(true);
      expect(fs.statSync(lock).ino).toBe(originalLock.ino);
      expect(fs.readFileSync(lock)).toHaveLength(0);
      expect(fs.readFileSync(path.join(external, "untouched"), "utf8")).toBe("outside the store");
    },
  );

  it.skipIf(process.platform === "win32").each(["FIFO", "socket", "hard-linked"] as const)(
    "leaves unrelated %s entries untouched",
    async (type) => {
      seedDatabase();
      const pathname = path.join(directory, "unsupported");
      const original = fs.statSync(directory);
      let server: net.Server | undefined;
      if (type === "FIFO") {
        const native =
          await vi.importActual<typeof import("node:child_process")>("node:child_process");
        expect(native.spawnSync("mkfifo", [pathname]).status).toBe(0);
      } else if (type === "socket") {
        server = net.createServer();
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(pathname, resolve);
        });
      } else {
        fs.linkSync(path.join(directory, "sibling.txt"), pathname);
      }
      try {
        const notes = (await repair()).join("\n");
        expect(notes).toContain("Rewrote SQLite files with NOCOW");
        expect(fixture.exchanges).toBe(3);
        expect(fs.statSync(directory).ino).toBe(original.ino);
      } finally {
        if (server) {
          await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
          });
        }
      }
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
      expect((await repair()).join(",")).toContain("Rewrote");
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
    {
      name: "missing fuser",
      result: {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync fuser ENOENT"), { code: "ENOENT" }),
      },
      detail: "spawnSync fuser ENOENT",
    },
    {
      name: "unexpected exit status",
      result: { status: 2, stdout: "", stderr: "" },
      detail: "exit status 2",
    },
    {
      name: "terminated fuser",
      result: { status: null, stdout: "", stderr: "", signal: "SIGTERM" as const },
      detail: "signal SIGTERM",
    },
  ])("refuses uncertain SQLite handles with $name", async (scenario) => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    fixture.fuserResult = { pid: 0, output: [], signal: null, ...scenario.result };
    expect((await repair()).join("\n")).toContain(
      `fuser could not establish that all handles are closed: ${scenario.detail}`,
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
      const result = await repairDoctorSqliteNoCow({
        paths: [sqlitePath],
        stateDir: root,
        env: { OPENCLAW_STATE_DIR: root },
        assertCurrent: () => {},
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
      const db = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM payload").get()?.value).toBe("in the WAL");
      } finally {
        db.close();
      }
    },
  );

  it.each(["database", "sidecar"])("refuses an aliased %s before mutation", async (kind) => {
    seedDatabase();
    const source = kind === "database" ? sqlitePath : `${sqlitePath}-wal`;
    fs.linkSync(source, path.join(root, "alias"));
    expect((await repair()).join("\n")).toContain("hard-linked path");
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
    expect(notes.join(",")).not.toContain("Rewrote");
    expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
    expect(fixture.exchanges).toBe(failure === "exchange-failed" ? 1 : 0);
    expect(notes.join(",")).toMatch(
      failure === "getfacl" || failure === "setfacl" || failure === "verification"
        ? /skipped/u
        : /refused|skipped/u,
    );
    expect(fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-backup-"))).toEqual(
      [],
    );
    if (failure === "corrupt") {
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-snapshots-")),
      ).toEqual([]);
    }
  });
});
