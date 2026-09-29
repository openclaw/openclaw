import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";
import { inspectDoctorSqliteNoCow, repairDoctorSqliteNoCow } from "./doctor-sqlite-nocow.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../infra/sqlite-wal-filesystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-wal-filesystem.js")>()),
  isSqlitePathOnBtrfs: vi.fn(() => true),
  setSqliteDirectoryNoCow: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let directory: string;
let sqlitePath: string;
let tools: "ok" | "unavailable" | "busy" | "exchange-failed" | "exchange-timeout";
let attributes: boolean;
let exchanges: number;
let acls: Map<string, string>;
let unavailableAclTool: "getfacl" | "setfacl" | undefined;
let rejectAclVerification: boolean;
let verifyPrivateAclBoundary: boolean;
const baseAcl = "user::rwx\ngroup::r-x\nother::---";
const inheritedDefaultAcl =
  "default:user::rwx\ndefault:user:12345:rwx\ndefault:group::r-x\ndefault:mask::rwx\ndefault:other::---";
const nativeStatfs = fs.statfsSync;

function permissions(bits: number): string {
  return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
}

function modeFromAcl(acl: string): number {
  const entryBits = (tag: string) => {
    const value =
      acl
        .split("\n")
        .find((line) => line.startsWith(`${tag}::`))
        ?.split(":")[2] ?? "---";
    return (
      (value.includes("r") ? 4 : 0) | (value.includes("w") ? 2 : 0) | (value.includes("x") ? 1 : 0)
    );
  };
  return (
    (entryBits("user") << 6) |
    (entryBits(acl.includes("\nmask::") ? "mask" : "group") << 3) |
    entryBits("other")
  );
}

function observedAcl(pathname: string): string {
  const stat = fs.statSync(pathname);
  const owner = permissions((stat.mode >> 6) & 7);
  const group = permissions((stat.mode >> 3) & 7);
  const other = permissions(stat.mode & 7);
  const acl =
    acls.get(pathname) ??
    (pathname.includes(".nocow-backup-")
      ? `user::${owner}\nuser:12345:rwx\ngroup::r-x\nmask::${group}\nother::${other}${stat.isDirectory() ? `\n${inheritedDefaultAcl}` : ""}`
      : `user::${owner}\ngroup::${group}\nother::${other}`);
  const masked = acl.includes("\nmask::");
  return acl
    .split("\n")
    .map((line) =>
      line.startsWith("user::")
        ? `user::${owner}`
        : line.startsWith("mask::")
          ? `mask::${group}`
          : line.startsWith("group::") && !masked
            ? `group::${group}`
            : line.startsWith("other::")
              ? `other::${other}`
              : line,
    )
    .join("\n");
}

beforeEach(() => {
  root = tempDirs.make("openclaw-nocow-");
  directory = path.join(root, "state");
  fs.mkdirSync(directory);
  sqlitePath = path.join(directory, "openclaw.sqlite");
  tools = "ok";
  attributes = false;
  exchanges = 0;
  acls = new Map();
  unavailableAclTool = undefined;
  rejectAclVerification = false;
  verifyPrivateAclBoundary = false;
  vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(true);
  vi.mocked(setSqliteDirectoryNoCow).mockImplementation((dir) => {
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const argv = args ?? [];
    let stdout = "";
    let status = 0;
    if (command === "lsattr") {
      stdout = `${attributes || String(argv.at(-1)).includes(".nocow-backup-") ? "-------C------" : "--------------"} ${argv.at(-1)}`;
      if (tools === "unavailable") {
        status = 127;
      }
    } else if (command === "getfacl" || command === "setfacl") {
      expect(options?.env?.POSIXLY_CORRECT).toBeUndefined();
      const pathname = String(argv.at(-1));
      const existing = observedAcl(pathname);
      if (unavailableAclTool === command) {
        status = 127;
      } else if (command === "getfacl") {
        expect(argv.slice(0, 2)).toEqual(["-cEpn", "--"]);
        stdout = existing;
      } else if (argv[0] === "-k") {
        acls.set(
          pathname,
          existing
            .split("\n")
            .filter((line) => !line.startsWith("default:"))
            .join("\n"),
        );
      } else {
        expect(argv.slice(0, 3)).toEqual(["-n", "--set-file=-", "--"]);
        if (typeof options?.input !== "string") {
          throw new Error("Expected textual ACL input");
        }
        const input = options.input.trim();
        if (verifyPrivateAclBoundary && fs.statSync(pathname).isDirectory()) {
          expect(fs.statSync(pathname).mode & 0o077).toBe(0);
          expect(input).toContain("user:12345:---");
        }
        const defaults = existing.split("\n").filter((line) => line.startsWith("default:"));
        acls.set(
          pathname,
          rejectAclVerification
            ? baseAcl
            : input.includes("default:")
              ? input
              : [input, ...defaults].join("\n"),
        );
        const applied = acls.get(pathname)!;
        fs.chmodSync(pathname, (fs.statSync(pathname).mode & 0o7000) | modeFromAcl(applied));
      }
    } else if (command === "fuser") {
      expect(argv.length).toBeGreaterThan(0);
      expect(argv.every((argument) => path.isAbsolute(argument))).toBe(true);
      status = tools === "busy" ? 0 : 1;
      stdout = tools === "busy" ? "12345" : "";
    } else if (command === "mv" && argv[0] === "--help") {
      stdout = tools === "unavailable" ? "mv" : "--exchange --no-copy";
    } else if (command === "mv") {
      expect(argv.slice(0, 4)).toEqual(["--exchange", "--no-copy", "-T", "--"]);
      exchanges++;
      if (tools === "exchange-failed") {
        return { status: 1, stdout: "", stderr: "denied", pid: 0, output: [], signal: null };
      }
      const source = String(argv.at(-2));
      const target = String(argv.at(-1));
      const temporary = `${target}.test-exchange`;
      fs.renameSync(target, temporary);
      fs.renameSync(source, target);
      fs.renameSync(temporary, source);
      if (tools === "exchange-timeout") {
        status = 1;
      }
    } else {
      throw new Error(`unexpected command: ${command}`);
    }
    return { status, stdout, stderr: "", pid: 0, output: [], signal: null };
  });
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    ...nativeStatfs(root, { bigint: true }),
    bavail: 1_000_000_000n,
    bsize: 4096n,
  });
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
  it("reports existing CoW stores, skips other filesystems and explains missing tooling", () => {
    fs.writeFileSync(sqlitePath, "fixture");
    expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([sqlitePath]);
    attributes = true;
    expect(inspectDoctorSqliteNoCow([sqlitePath]).paths).toEqual([]);
    vi.mocked(isSqlitePathOnBtrfs).mockReturnValue(false);
    tools = "unavailable";
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
      tools = outcome;
      fs.chmodSync(sqlitePath, 0o640);
      fs.chmodSync(directory, 0o750);
      const original = fs.statSync(sqlitePath);
      const originalDirectory = fs.statSync(directory);
      const notes = await repair();
      expect(notes.join(",")).toContain("Rewrote SQLite store directory with NOCOW");
      expect(exchanges).toBe(1);
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
      acls.set(sqlitePath, fileAcl);
      acls.set(directory, directoryAcl);
      expect((await repair()).join(",")).toContain("Rewrote");
      const stagedDirectory = [...acls.keys()].find(
        (pathname) =>
          pathname.includes(".nocow-backup-") &&
          !pathname.endsWith(".sqlite") &&
          !pathname.endsWith(".txt"),
      )!;
      expect(acls.get(stagedDirectory)).toBe(directoryAcl);
      expect(acls.get(path.join(stagedDirectory, "openclaw.sqlite"))).toBe(fileAcl);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps inherited named grants masked until the source directory ACL denies them",
    async () => {
      seedDatabase();
      acls.set(directory, "user::rwx\nuser:12345:---\ngroup::r-x\nmask::r-x\nother::---");
      const originalMode = fs.statSync(directory).mode;
      verifyPrivateAclBoundary = true;
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
        unavailableAclTool = failure;
      }
      if (failure === "changed-directory-acl") {
        vi.mocked(setSqliteDirectoryNoCow).mockImplementation(() => {
          acls.set(directory, `${baseAcl}\n${inheritedDefaultAcl}`);
        });
      }
      if (failure === "verification") {
        acls.set(sqlitePath, "user::rw-\nuser:12345:r--\ngroup::r--\nmask::r--\nother::---");
        rejectAclVerification = true;
      }
      const notes = await repair();
      expect(notes.join(",")).toMatch(/refused/u);
      expect(exchanges).toBe(0);
      expect(fs.statSync(sqlitePath).ino).toBe(original.ino);
      if (failure === "changed-directory-acl") {
        expect(notes.join(",")).toContain("source store changed");
      }
    },
  );

  it.each([
    "space",
    "busy",
    "unavailable",
    "authority",
    "corrupt",
    "exchange-failed",
    "changed-source",
  ] as const)("leaves the previous store intact on %s refusal", async (failure) => {
    seedDatabase();
    const original = fs.statSync(sqlitePath);
    if (failure === "space") {
      vi.mocked(fs.statfsSync).mockReturnValue({
        ...nativeStatfs(root, { bigint: true }),
        bavail: 0n,
      });
    }
    if (failure === "busy" || failure === "unavailable" || failure === "exchange-failed") {
      tools = failure;
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
    expect(exchanges).toBe(failure === "exchange-failed" ? 1 : 0);
    expect(notes.join(",")).toMatch(/refused|skipped/u);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-backup-"))).toEqual(
      [],
    );
    if (failure === "corrupt") {
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith("state.nocow-snapshots-")),
      ).toEqual([]);
    }
    if (failure === "changed-source") {
      expect(notes.join(",")).toContain("source store changed");
    }
  });
});
