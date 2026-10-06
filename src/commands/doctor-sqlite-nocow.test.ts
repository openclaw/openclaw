import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteReaderDiagnosticsForPath } from "../infra/sqlite-reader-lifecycle.js";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";
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
    assertCurrent,
  });
  return [...result.changes, ...result.warnings];
}

describe("Doctor btrfs NOCOW", () => {
  it.skipIf(process.platform !== "linux")(
    "rewrites shared and agent stores after the real Doctor maintenance scope drains",
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
            expect(fixture.exchanges).toBe(4);
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
              log.mock.calls.filter(([line]) => line.startsWith("Rewrote SQLite")),
            ).toHaveLength(4);
          } finally {
            await maintenance?.release();
          }
        },
      );
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
      expect((await repair()).join(",")).toContain("Rewrote SQLite store directory with NOCOW");
      expect(fixture.exchanges).toBe(1);
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
        if (command === "fuser") {
          expect(args).toContain(lock);
          for (const pathname of args ?? []) {
            expect(fs.lstatSync(pathname).isSymbolicLink()).toBe(false);
            expect(pathname.startsWith(external)).toBe(false);
          }
        }
        return tool(command, args, options);
      });

      expect((await repair()).join("\n")).toContain("Rewrote SQLite store directory with NOCOW");
      expect(fixture.exchanges).toBe(1);
      for (const [index, [pathname, target]] of [...links].entries()) {
        const stat = fs.lstatSync(pathname);
        expect(stat.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(pathname, { encoding: "buffer" })).toEqual(target);
        expect([stat.uid, stat.gid]).toEqual([owners[index]!.uid, owners[index]!.gid]);
      }
      expect(fs.existsSync(path.join(nested, "dangling.sqlite"))).toBe(false);
      expect(fs.statSync(lock).isFile()).toBe(true);
      expect(fs.statSync(lock).ino).not.toBe(originalLock.ino);
      expect(fs.readFileSync(lock)).toHaveLength(0);
      expect(fs.readFileSync(path.join(external, "untouched"), "utf8")).toBe("outside the store");
    },
  );

  it.skipIf(process.platform === "win32").each(["FIFO", "socket", "hard-linked"] as const)(
    "refuses a %s entry with its type and path before exchanging the store",
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
        expect(notes).toContain(
          type === "hard-linked"
            ? "hard-linked path:"
            : `unsupported store directory entry (${type}): ${pathname}`,
        );
        expect(fixture.exchanges).toBe(0);
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
      if (kind === "denied-grant") {
        fixture.verifyPrivateAclBoundary = true;
      } else {
        fixture.acls.set(sqlitePath, fileAcl);
      }
      const originalMode = fs.statSync(directory).mode;
      expect((await repair()).join(",")).toContain("Rewrote");
      if (kind === "denied-grant") {
        expect(fs.statSync(directory).mode).toBe(originalMode);
      } else {
        const stagedDirectory = [...fixture.acls.keys()].find(
          (pathname) =>
            pathname.includes(".nocow-backup-") &&
            !pathname.endsWith(".sqlite") &&
            !pathname.endsWith(".txt"),
        )!;
        expect(fixture.acls.get(stagedDirectory)).toBe(directoryAcl);
        expect(fixture.acls.get(path.join(stagedDirectory, "openclaw.sqlite"))).toBe(fileAcl);
      }
    },
  );

  it.each([
    { name: "many sibling files", count: 2_001, suffix: "", outcome: "holders" },
    { name: "long UTF-8 paths", count: 320, suffix: "界".repeat(60), outcome: "closed" },
    {
      name: "an inspection failure in a later batch",
      count: 320,
      suffix: "界".repeat(60),
      outcome: "inspection-error",
    },
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
  ])("inspects every file and refuses uncertain handles with $name", async (scenario) => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    if (scenario.result) {
      fixture.fuserResult = { pid: 0, output: [], signal: null, ...scenario.result };
      const notes = (await repair()).join("\n");
      expect(notes).toContain(
        `fuser could not establish that all handles are closed: ${scenario.detail}`,
      );
      expect(notes).not.toContain("store files are open");
      expect(fixture.exchanges).toBe(0);
      expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
      return;
    }
    const { count, suffix, outcome } = scenario;
    const nested = path.join(directory, "workshop-skills");
    fs.mkdirSync(nested);
    const files = [
      sqlitePath,
      `${sqlitePath}-wal`,
      `${sqlitePath}-shm`,
      path.join(directory, "sibling.txt"),
    ];
    for (let index = 0; index < count; index++) {
      const pathname = path.join(nested, `${index}-${suffix}.txt`);
      fs.writeFileSync(pathname, "preserved sibling");
      files.push(pathname);
    }
    const tool = vi.mocked(spawnSync).getMockImplementation()!;
    const batches: string[][] = [];
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      if (command !== "fuser") {
        return tool(command, args, options);
      }
      const argv = [...(args ?? [])];
      batches.push(argv);
      const result = { status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null };
      if (
        argv.length > 2_000 ||
        argv.reduce((bytes, pathname) => bytes + Buffer.byteLength(pathname, "utf8") + 1, 0) >
          64 * 1024
      ) {
        return {
          ...result,
          status: null,
          error: Object.assign(new Error("spawnSync fuser E2BIG"), { code: "E2BIG" }),
        };
      }
      if (outcome === "holders") {
        return {
          ...result,
          status: 0,
          stdout: batches.length === 1 ? " 12345 12345" : "67890",
          stderr: "/synthetic/store.sqlite:\n",
        };
      }
      if (outcome === "inspection-error" && batches.length > 1) {
        return { ...result, stderr: "Cannot stat file /proc/123/fd/4: Permission denied\n" };
      }
      return result;
    });
    const notes = (await repair()).join("\n");
    expect(notes).not.toContain("E2BIG");
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().slice(0, files.length).toSorted()).toEqual(files.toSorted());
    if (outcome === "closed") {
      expect(notes).toContain("Rewrote SQLite store directory with NOCOW");
      expect(fixture.exchanges).toBe(1);
      expect(fs.readFileSync(files.at(-1)!, "utf8")).toBe("preserved sibling");
      expect(batches.flat().filter((pathname) => pathname === sqlitePath)).toHaveLength(2);
    } else {
      expect(notes).toContain(
        outcome === "holders"
          ? "store files are open (pids: 12345, 67890)"
          : "fuser could not establish that all handles are closed: Cannot stat file /proc/123/fd/4: Permission denied",
      );
      expect(notes).not.toContain(
        outcome === "holders" ? "could not establish" : "store files are open",
      );
      expect(fixture.exchanges).toBe(0);
      expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
    }
  });

  it.each([
    "space",
    "getfacl",
    "setfacl",
    "changed-directory-acl",
    "verification",
    "unavailable",
    "authority",
    "corrupt",
    "exchange-failed",
    "changed-source",
    ...(process.platform === "win32" ? [] : ["changed-symlink" as const]),
    "new-wal",
    "changed-wal",
  ] as const)("leaves the previous store intact on %s refusal", async (failure) => {
    seedDatabase();
    if (failure === "new-wal") {
      const db = openNodeSqliteDatabase(sqlitePath);
      db.prepare("SELECT value FROM payload").get();
      db.close();
      expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    }
    if (failure === "new-wal" || failure === "changed-wal") {
      const tool = vi.mocked(spawnSync).getMockImplementation()!;
      let inspections = 0;
      vi.mocked(spawnSync).mockImplementation((command, args, options) => {
        const result = tool(command, args, options);
        if (command === "fuser" && ++inspections === 2) {
          fs.appendFileSync(`${sqlitePath}-wal`, "unexpected writer");
        }
        return result;
      });
    }
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
    if (failure === "changed-source") {
      vi.mocked(setSqliteDirectoryNoCow).mockImplementation(() => {
        fs.writeFileSync(path.join(directory, "sibling.txt"), "changed by another writer");
      });
    }
    if (failure === "changed-directory-acl") {
      vi.mocked(setSqliteDirectoryNoCow).mockImplementation(() => {
        fixture.acls.set(directory, `${baseAcl}\n${inheritedDefaultAcl}`);
      });
    }
    if (failure === "verification") {
      fixture.acls.set(sqlitePath, "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---");
      fixture.rejectAclVerification = true;
    }
    if (failure === "changed-symlink") {
      const link = path.join(directory, "link");
      fs.symlinkSync("sibling.txt", link);
      vi.mocked(setSqliteDirectoryNoCow).mockImplementationOnce(() => {
        fs.unlinkSync(link);
        fs.symlinkSync("changed-target", link);
      });
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
      failure === "getfacl" ||
        failure === "setfacl" ||
        failure === "changed-directory-acl" ||
        failure === "verification"
        ? /refused/u
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
    if (
      failure === "changed-source" ||
      failure === "changed-directory-acl" ||
      failure === "changed-symlink" ||
      failure === "new-wal" ||
      failure === "changed-wal"
    ) {
      expect(notes.join(",")).toContain("source store changed");
    }
  });
});
