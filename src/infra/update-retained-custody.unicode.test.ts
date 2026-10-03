import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../config/write-lock.js";
import { withGatewayServiceOperationLock } from "../daemon/service-operation-lock.js";
import {
  acquireFileLock,
  drainFileLockStateForTest,
  resetFileLockStateForTest,
} from "../plugin-sdk/file-lock.js";
import * as pathCase from "./path-case.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import {
  heldServiceLockCoordinate,
  seedRetainedBorrower,
  type RetainedBorrowerSource,
} from "./update-retained-custody.test-support.js";

const fixture = vi.hoisted(() => ({
  root: "",
  nativeCalls: vi.fn(() => {
    throw new Error("Native execution forbidden in pure Unicode borrower test");
  }),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: fixture.nativeCalls,
  spawnSync: fixture.nativeCalls,
  exec: fixture.nativeCalls,
  execSync: fixture.nativeCalls,
  execFile: fixture.nativeCalls,
  execFileSync: fixture.nativeCalls,
  fork: fixture.nativeCalls,
}));
vi.mock("../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => false,
  getFileLockProcessStartTime: () => 123,
}));
vi.mock("../process/child-process-tree.js", () => ({ isChildProcessTreeAlive: () => false }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

let dir: string;
let install: string;
let nfc: string;
let nfd: string;
let store: ReturnType<typeof createManagedHandoffLeaseStore>;
let source: RetainedBorrowerSource;
const retry = { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 };

beforeEach(() => {
  fixture.nativeCalls.mockClear();
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "borrower-unicode-")));
  fs.chmodSync(fixture.root, 0o700);
  dir = path.join(fixture.root, "sources");
  install = path.join(fixture.root, "install");
  fs.mkdirSync(dir);
  fs.mkdirSync(install);
  nfc = path.join(dir, "caf\u00e9.json");
  nfd = path.join(dir, "cafe\u0301.json");
  source = {
    runId: "run",
    transactionId: "transaction",
    claimId: "claim",
    revision: 1,
    recordSha256: "a".repeat(64),
    lifetimeId: "lifetime",
    serviceKey: path.join(fixture.root, "unrelated-service"),
    configPaths: [nfc],
  };
  store = createManagedHandoffLeaseStore();
  resetFileLockStateForTest();
});
afterEach(async () => {
  await drainFileLockStateForTest();
  expect(fixture.nativeCalls).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function acquire() {
  const result = store.acquire(install, "owner", { kind: "update" });
  if (result.kind !== "acquired") {
    throw new Error("fixture parent unavailable");
  }
  return result.lease;
}
function seedRetained(parent = acquire(), phase: "reserved" | "admitted" = "reserved") {
  seedRetainedBorrower(
    path.join(fixture.root, "managed-update-handoffs.sqlite"),
    parent,
    source,
    phase,
  );
  const result = store.read(parent.key);
  if (result.kind !== "current" || result.lease.version !== 3) {
    throw new Error("Retained fixture record unavailable");
  }
  return result.lease;
}

function rows() {
  const db = new DatabaseSync(path.join(fixture.root, "managed-update-handoffs.sqlite"), {
    readOnly: true,
  });
  try {
    return JSON.stringify(
      db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all(),
    );
  } finally {
    db.close();
  }
}
function snapshot(file: string) {
  const stat = fs.statSync(file);
  return { bytes: fs.readFileSync(file), dev: stat.dev, ino: stat.ino };
}
function sharedAlias(suffix: string) {
  fs.writeFileSync(
    nfc + suffix,
    suffix
      ? JSON.stringify({
          pid: 10000001,
          starttime: 1,
          createdAt: "2000-01-01T00:00:00Z",
        })
      : "{}",
  );
  // Actual canonical alias on normalizing hosts; real same-inode hardlink on
  // sensitive hosts. The latter proves object identity, not Unicode semantics.
  if (!fs.existsSync(nfd + suffix)) {
    fs.linkSync(nfc + suffix, nfd + suffix);
  }
  expect(fs.statSync(nfc + suffix).ino).toBe(fs.statSync(nfd + suffix).ino);
}
async function withService(fn: () => Promise<void>) {
  return withGatewayServiceOperationLock({}, async (assertService) => {
    assertService();
    return fn();
  });
}

describe("Unicode borrower identity before lock creation (pure)", () => {
  it.each(["reserved", "admitted"] as const)(
    "refuses unknown NFC/NFD absence before config or service-nested sidecar creation (%s)",
    async (phase) => {
      const lease = seedRetained(acquire(), phase);
      const beforeRows = rows();
      for (const wrap of [(fn: () => Promise<void>) => fn(), withService]) {
        const callback = vi.fn(async () => undefined);
        const result = await wrap(() => withConfigWriteLock(nfd, callback, {})).then(
          () => undefined,
          (error: unknown) => error,
        );
        // Keep callback admission and physical sidecar creation separate. Old
        // code can reject after creating a sidecar without entering callback.
        expect(callback).not.toHaveBeenCalled();
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toMatch(/alias identity|native custody/);
        expect(rows()).toBe(beforeRows);
        expect(store.release(lease)).toBe(false);
        expect(
          fs
            .readdirSync(fixture.root)
            .filter((name) => name.startsWith("service-lifecycle-") && name.endsWith(".lock")),
        ).toEqual([]);
      }
    },
  );

  it.each([true, false])(
    "case semantics (%s) do not decide absent Unicode identity",
    (caseInsensitive) => {
      const detector = vi
        .spyOn(pathCase, "tryResolvePathCaseInsensitive")
        .mockReturnValue(caseInsensitive);
      const lease = seedRetained();
      const before = rows();
      expect(() => store.assertSourceUnborrowed(nfd)).toThrow(/alias identity/);
      expect(detector).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(rows()).toBe(before);
      expect(store.release(lease)).toBe(false);
    },
  );

  it.each(["", ".lock"])(
    "preserves same-inode Unicode identity and bytes through wrappers (%s)",
    async (suffix) => {
      sharedAlias(suffix);
      const original = snapshot(nfc + suffix);
      seedRetained();
      const beforeRows = rows();
      const callback = vi.fn(async () => undefined);
      await expect(withService(() => withConfigWriteLock(nfd, callback, {}))).rejects.toThrow(
        "native custody",
      );
      expect(callback).not.toHaveBeenCalled();
      expect(snapshot(nfc + suffix)).toEqual(original);
      expect(snapshot(nfd + suffix)).toEqual(original);
      if (!suffix) {
        expect(fs.existsSync(nfd + ".lock")).toBe(false);
      }
      expect(rows()).toBe(beforeRows);
    },
  );

  it("uses read-only path-local normalization evidence when available", async () => {
    const witness = path.join(dir, "\u00e9vidence");
    fs.writeFileSync(witness, "");
    const names = fs.readdirSync(dir);
    const observedName = names[0]!;
    const alternative =
      observedName === observedName.normalize("NFC")
        ? observedName.normalize("NFD")
        : observedName.normalize("NFC");
    const insensitive = fs.existsSync(path.join(dir, alternative));
    const lease = seedRetained();
    const beforeRows = rows();
    if (insensitive) {
      const callback = vi.fn(async () => undefined);
      await expect(withConfigWriteLock(nfd, callback, {})).rejects.toThrow("native custody");
      expect(callback).not.toHaveBeenCalled();
    } else {
      await withConfigWriteLock(nfd, async () => undefined, {});
    }
    expect(fs.readdirSync(dir)).toEqual(names);
    expect(rows()).toBe(beforeRows);
    expect(store.release(lease)).toBe(false);
  });

  it("keeps known normalization-sensitive absence distinct (modeled lookup, real store)", () => {
    // Model only alternate lookup of an existing sibling, never the matcher or
    // SQLite. This proves the sensitive branch on hosts with normalizing APFS.
    const witness = path.join(dir, "\u00e9vidence");
    fs.writeFileSync(witness, "");
    const observedName = fs.readdirSync(dir)[0]!;
    const alternative =
      observedName === observedName.normalize("NFC")
        ? observedName.normalize("NFD")
        : observedName.normalize("NFC");
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (args[0] === path.join(dir, alternative)) {
        throw Object.assign(new Error("modeled normalization-sensitive ENOENT"), {
          code: "ENOENT",
        });
      }
      return Reflect.apply(lstat, fs, args);
    });
    seedRetained();
    const before = rows();
    expect(() => store.assertSourceUnborrowed(nfd)).not.toThrow();
    expect(rows()).toBe(before);
    expect(fs.existsSync(nfc)).toBe(false);
    expect(fs.existsSync(nfd + ".lock")).toBe(false);
  });

  it.each([true, false])(
    "mixed case/Unicode aliases require both semantics (modeled case-insensitive=%s)",
    (caseInsensitive) => {
      const witness = path.join(dir, "évidence");
      fs.writeFileSync(witness, "");
      const observedName = fs.readdirSync(dir)[0]!;
      const alternate =
        observedName === observedName.normalize("NFC")
          ? observedName.normalize("NFD")
          : observedName.normalize("NFC");
      const lstat = fs.lstatSync.bind(fs);
      // Model normalization-insensitive sibling lookup independently of case.
      vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
        const [file, ...rest] = args;
        return Reflect.apply(lstat, fs, [
          file === path.join(dir, alternate) ? path.join(dir, observedName) : file,
          ...rest,
        ]);
      });
      const detector = vi
        .spyOn(pathCase, "tryResolvePathCaseInsensitive")
        .mockReturnValue(caseInsensitive);
      seedRetained();
      const before = rows();
      const alias = path.join(dir, path.basename(nfd).toUpperCase());
      if (caseInsensitive) {
        expect(() => store.assertSourceUnborrowed(alias)).toThrow("native custody");
      } else {
        expect(() => store.assertSourceUnborrowed(alias)).not.toThrow();
      }
      expect(detector).toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([observedName]);
      expect(rows()).toBe(before);
    },
  );

  it("unreadable normalization evidence refuses before sidecar creation", async () => {
    const witness = path.join(dir, "évidence");
    fs.writeFileSync(witness, "");
    const names = fs.readdirSync(dir);
    const lstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (typeof args[0] === "string" && path.basename(args[0]).normalize("NFC") === "évidence") {
        throw Object.assign(new Error("modeled unreadable normalization evidence"), {
          code: "EACCES",
        });
      }
      return Reflect.apply(lstat, fs, args);
    });
    seedRetained();
    const before = rows();
    const callback = vi.fn(async () => undefined);
    await expect(withConfigWriteLock(nfd, callback, {})).rejects.toThrow(/alias identity/);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(names);
    expect(rows()).toBe(before);
  });

  it("preserves affirmative distinct target and sidecar objects (modeled sensitive lookup)", () => {
    const other = path.join(dir, "distinct");
    for (const file of [nfc, other]) {
      fs.writeFileSync(file, "{}");
      fs.writeFileSync(file + ".lock", "held-sidecar");
    }
    const before = [
      snapshot(nfc),
      snapshot(nfc + ".lock"),
      snapshot(other),
      snapshot(other + ".lock"),
    ];
    const stat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const [file, ...rest] = args;
      return Reflect.apply(stat, fs, [
        file === nfd ? other : file === nfd + ".lock" ? other + ".lock" : file,
        ...rest,
      ]);
    });
    seedRetained();
    const beforeRows = rows();
    expect(() => store.assertSourceUnborrowed(nfd)).not.toThrow();
    expect(() => store.assertSourceUnborrowed(nfc)).toThrow("native custody");
    expect([
      snapshot(nfc),
      snapshot(nfc + ".lock"),
      snapshot(other),
      snapshot(other + ".lock"),
    ]).toEqual(before);
    expect(rows()).toBe(beforeRows);
  });

  it("preserves Unicode sidecar identity at final stale removal", async () => {
    sharedAlias(".lock");
    const before = snapshot(nfc + ".lock");
    const parent = acquire();
    let calls = 0;
    let beforeRows = "";
    await expect(
      acquireFileLock(nfd, {
        retries: retry,
        stale: 1,
        assertResourceUnborrowed(target) {
          if (++calls === 3) {
            seedRetained(parent);
            beforeRows = rows();
          }
          store.assertSourceUnborrowed(target);
        },
      }),
    ).rejects.toThrow("native custody");
    expect(calls).toBe(3);
    expect(snapshot(nfc + ".lock")).toEqual(before);
    expect(snapshot(nfd + ".lock")).toEqual(before);
    expect(rows()).toBe(beforeRows);
  });

  it("retains config and service sidecars when Unicode custody arises during an interval", async () => {
    const parent = acquire();
    let configBefore: ReturnType<typeof snapshot> | undefined;
    let serviceBefore: ReturnType<typeof snapshot> | undefined;
    let beforeRows = "";
    let service = "";
    await expect(
      withService(() =>
        withConfigWriteLock(
          nfd,
          async () => {
            if (!fs.existsSync(nfc + ".lock")) {
              fs.linkSync(nfd + ".lock", nfc + ".lock");
            }
            configBefore = snapshot(nfd + ".lock");
            service = heldServiceLockCoordinate(fixture.root);
            serviceBefore = snapshot(service + ".lock");
            source.serviceKey = service;
            seedRetained(parent, "admitted");
            beforeRows = rows();
            const nested = vi.fn(async () => undefined);
            await expect(withService(nested)).rejects.toThrow("native custody");
            expect(nested).not.toHaveBeenCalled();
          },
          {},
        ),
      ),
    ).rejects.toThrow(/native custody|release/);
    expect(snapshot(nfd + ".lock")).toEqual(configBefore);
    expect(snapshot(nfc + ".lock")).toEqual(configBefore);
    expect(snapshot(service + ".lock")).toEqual(serviceBefore);
    expect(rows()).toBe(beforeRows);
  });
});
