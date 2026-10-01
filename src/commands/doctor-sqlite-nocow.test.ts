import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
              const agent = openOpenClawAgentDatabase({ agentId: "main" });
              for (const database of [state, agent]) {
                database.db.exec(
                  "CREATE TABLE nocow_payload(value TEXT); INSERT INTO nocow_payload VALUES ('preserved');",
                );
              }
              return inspectDoctorSqliteNoCow([state.path, agent.path]).paths;
            });
            expect(paths).toHaveLength(2);
            const originals = paths.map((pathname) => fs.statSync(pathname).ino);
            await maintenance!.repairSqliteNoCow(paths);
            expect(maintenance!.warnings).toEqual([]);
            expect(fixture.exchanges).toBe(2);
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
            ).toHaveLength(2);
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

  it.each(["ok", "exchange-timeout"] as const)(
    "preserves WAL rows and siblings, retains original identity, and settles %s exchange",
    async (outcome) => {
      seedDatabase();
      fixture.tools = outcome;
      fs.chmodSync(sqlitePath, 0o640);
      fs.chmodSync(directory, 0o750);
      const original = fs.statSync(sqlitePath);
      const originalDirectory = fs.statSync(directory);
      const notes = await repair();
      expect(notes.join(",")).toContain("Rewrote SQLite store directory with NOCOW");
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
    },
  );

  it("restores original ownership before file permissions when copying as another owner", async () => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((pathname, options) => {
      const value = stat(pathname, options);
      if (value && String(pathname).includes(".nocow-backup-") && typeof value.uid === "number") {
        return Object.assign(value, { uid: value.uid + 1 });
      }
      return value;
    });
    const chown = vi.spyOn(fs, "chownSync");
    const chmod = vi.spyOn(fs, "chmodSync");
    expect((await repair()).join(",")).toContain("Rewrote");
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
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "preserves named access ACLs and exact source default ACLs (default=%s)",
    async (defaults) => {
      seedDatabase();
      const fileAcl = "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---";
      const directoryAcl = defaults ? `${baseAcl}\n${inheritedDefaultAcl}` : baseAcl;
      fixture.acls.set(sqlitePath, fileAcl);
      fixture.acls.set(directory, directoryAcl);
      expect((await repair()).join(",")).toContain("Rewrote");
      const stagedDirectory = [...fixture.acls.keys()].find(
        (pathname) =>
          pathname.includes(".nocow-backup-") &&
          !pathname.endsWith(".sqlite") &&
          !pathname.endsWith(".txt"),
      )!;
      expect(fixture.acls.get(stagedDirectory)).toBe(directoryAcl);
      expect(fixture.acls.get(path.join(stagedDirectory, "openclaw.sqlite"))).toBe(fileAcl);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps inherited named grants masked until the source directory ACL denies them",
    async () => {
      seedDatabase();
      fixture.acls.set(directory, "user::rwx\nuser:12345:---\ngroup::r-x\nmask::r-x\nother::---");
      const originalMode = fs.statSync(directory).mode;
      fixture.verifyPrivateAclBoundary = true;
      expect((await repair()).join(",")).toContain("Rewrote");
      expect(fs.statSync(directory).mode).toBe(originalMode);
    },
  );

  it.each(["getfacl", "setfacl", "changed-directory-acl", "verification"] as const)(
    "keeps the original store when ACL preservation fails: %s",
    async (failure) => {
      seedDatabase();
      const original = fs.statSync(sqlitePath);
      if (failure === "getfacl" || failure === "setfacl") {
        fixture.unavailableAclTool = failure;
      }
      if (failure === "changed-directory-acl") {
        vi.mocked(setSqliteDirectoryNoCow).mockImplementation(() => {
          fixture.acls.set(directory, `${baseAcl}\n${inheritedDefaultAcl}`);
        });
      }
      if (failure === "verification") {
        fixture.acls.set(
          sqlitePath,
          "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---",
        );
        fixture.rejectAclVerification = true;
      }
      const notes = await repair();
      expect(notes.join(",")).toMatch(/refused/u);
      expect(fixture.exchanges).toBe(0);
      expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
      if (failure === "changed-directory-acl") {
        expect(notes.join(",")).toContain("source store changed");
      }
    },
  );

  it.each([
    {
      name: "open handles",
      result: { status: 0, stdout: " 12345 67890", stderr: "/synthetic/store.sqlite:\n" },
      detail: "store files are open (pids: 12345, 67890)",
      absent: "could not establish",
    },
    {
      name: "incomplete process inspection",
      result: {
        status: 1,
        stdout: "",
        stderr: "Cannot stat file /proc/123/fd/4: Permission denied\n",
      },
      detail:
        "fuser could not establish that all handles are closed: Cannot stat file /proc/123/fd/4: Permission denied",
      absent: "store files are open",
    },
    {
      name: "missing fuser",
      result: {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync fuser ENOENT"), { code: "ENOENT" }),
      },
      detail: "fuser could not establish that all handles are closed: spawnSync fuser ENOENT",
      absent: "store files are open",
    },
    {
      name: "unexpected exit status",
      result: { status: 2, stdout: "", stderr: "" },
      detail: "fuser could not establish that all handles are closed: exit status 2",
      absent: "store files are open",
    },
    {
      name: "terminated fuser",
      result: { status: null, stdout: "", stderr: "", signal: "SIGTERM" as const },
      detail: "fuser could not establish that all handles are closed: signal SIGTERM",
      absent: "store files are open",
    },
  ])("distinguishes $name without exchanging the store", async ({ result, detail, absent }) => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    fixture.fuserResult = { pid: 0, output: [], signal: null, ...result };
    const notes = (await repair()).join("\n");
    expect(notes).toContain(detail);
    expect(notes).not.toContain(absent);
    expect(fixture.exchanges).toBe(0);
    expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
  });

  it.each([
    "space",
    "busy",
    "unavailable",
    "authority",
    "corrupt",
    "exchange-failed",
    "changed-source",
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
    if (failure === "busy" || failure === "unavailable" || failure === "exchange-failed") {
      fixture.tools = failure;
    }
    if (failure === "corrupt") {
      fs.unlinkSync(`${sqlitePath}-wal`);
      fs.unlinkSync(`${sqlitePath}-shm`);
      fs.writeFileSync(sqlitePath, "not a database");
    }
    if (failure === "changed-source") {
      vi.mocked(setSqliteDirectoryNoCow).mockImplementation(() => {
        fs.writeFileSync(path.join(directory, "sibling.txt"), "changed by another writer");
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
    expect(notes.join(",")).toMatch(/refused|skipped/u);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-backup-"))).toEqual(
      [],
    );
    if (failure === "corrupt") {
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-snapshots-")),
      ).toEqual([]);
    }
    if (failure === "changed-source" || failure === "new-wal" || failure === "changed-wal") {
      expect(notes.join(",")).toContain("source store changed");
    }
  });
});
