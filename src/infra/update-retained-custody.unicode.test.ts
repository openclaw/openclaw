import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
let verifyPreserved: Array<() => void>;
const retry = { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 };
const databasePath = () => path.join(fixture.root, "managed-update-handoffs.sqlite");

beforeEach(() => {
  verifyPreserved = [];
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
  try {
    verifyAll();
  } finally {
    await drainFileLockStateForTest();
    expect(fixture.nativeCalls).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function acquire() {
  const result = store.acquire(install, "owner", { kind: "update" });
  if (result.kind !== "acquired") {
    throw new Error("fixture parent unavailable");
  }
  return result.lease;
}
function seedRetained(parent = acquire(), phase: "reserved" | "admitted" = "reserved") {
  seedRetainedBorrower(databasePath(), parent, source, phase);
  const result = store.read(parent.key);
  if (result.kind !== "current" || result.lease.version !== 3) {
    throw new Error("Retained fixture record unavailable");
  }
  preserve(() => ({ names: fs.readdirSync(dir), rows: rows() }));
  return result.lease;
}

function rows() {
  const db = new DatabaseSync(databasePath(), { readOnly: true });
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
function preserve<T>(read: () => T) {
  const before = read();
  verifyPreserved.push(() => expect(read()).toEqual(before));
  return before;
}
function verifyAll() {
  for (const verify of verifyPreserved) {
    verify();
  }
}
function preserveFiles(...files: string[]) {
  return preserve(() => files.map(snapshot));
}
function normalizationWitness() {
  fs.writeFileSync(path.join(dir, "évidence"), "");
  const observedName = fs.readdirSync(dir)[0]!;
  const alternate = observedName.normalize(
    observedName === observedName.normalize("NFC") ? "NFD" : "NFC",
  );
  return { observedName, alternate };
}
async function blockedConfig(
  message: RegExp,
  wrap: (fn: () => Promise<void>) => Promise<void> = (fn) => fn(),
) {
  const callback = vi.fn(async () => undefined);
  const result = await wrap(() => withConfigWriteLock(nfd, callback, {})).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toMatch(message);
  expect(callback).not.toHaveBeenCalled();
}
function mapStat(method: "statSync" | "lstatSync", map: (file: fs.PathLike) => fs.PathLike) {
  const original = fs[method].bind(fs);
  vi.spyOn(fs, method).mockImplementation((...args) =>
    Reflect.apply(original, fs, [map(args[0]), ...args.slice(1)]),
  );
}
function sharedAlias(suffix: string) {
  fs.writeFileSync(
    nfc + suffix,
    suffix
      ? JSON.stringify({ pid: 10000001, starttime: 1, createdAt: "2000-01-01T00:00:00Z" })
      : "{}",
  );
  // Actual canonical alias on normalizing hosts; real same-inode hardlink on
  // sensitive hosts. The latter proves object identity, not Unicode semantics.
  if (!fs.existsSync(nfd + suffix)) {
    fs.linkSync(nfc + suffix, nfd + suffix);
  }
  const [canonical, alias] = preserveFiles(nfc + suffix, nfd + suffix);
  expect(alias).toEqual(canonical);
}
async function withService(fn: () => Promise<void>) {
  return withGatewayServiceOperationLock({}, async (assertService) => {
    assertService();
    return fn();
  });
}

it.each(["reserved", "admitted"] as const)(
  "rejects ambiguous Unicode aliases before creating sidecars (%s)",
  async (phase) => {
    const lease = seedRetained(acquire(), phase);
    for (const wrap of [(fn: () => Promise<void>) => fn(), withService]) {
      // Keep callback admission and physical sidecar creation separate. Old
      // code can reject after creating a sidecar without entering callback.
      await blockedConfig(/alias identity|native custody/, wrap);
      verifyAll();
      expect(store.release(lease)).toBe(false);
      expect(
        fs
          .readdirSync(fixture.root)
          .filter((name) => name.startsWith("service-lifecycle-") && name.endsWith(".lock")),
      ).toEqual([]);
    }
  },
);

it.each(["", ".lock"])(
  "preserves same-inode Unicode identity and bytes through wrappers (%s)",
  async (suffix) => {
    sharedAlias(suffix);
    seedRetained();
    await blockedConfig(/native custody/, withService);
    if (!suffix) {
      expect(fs.existsSync(nfd + ".lock")).toBe(false);
    }
  },
);

it("uses read-only path-local normalization evidence when available", async () => {
  const { alternate } = normalizationWitness();
  const insensitive = fs.existsSync(path.join(dir, alternate));
  const lease = seedRetained();
  if (insensitive) {
    await blockedConfig(/native custody/);
  } else {
    await withConfigWriteLock(nfd, async () => undefined, {});
  }
  expect(store.release(lease)).toBe(false);
});

it.each([true, false])(
  "mixed case/Unicode aliases require both semantics (modeled case-insensitive=%s)",
  (caseInsensitive) => {
    const { observedName, alternate } = normalizationWitness();
    // Model normalization-insensitive sibling lookup independently of case.
    mapStat("lstatSync", (file) =>
      file === path.join(dir, alternate) ? path.join(dir, observedName) : file,
    );
    const detector = vi
      .spyOn(pathCase, "tryResolvePathCaseInsensitive")
      .mockReturnValue(caseInsensitive);
    seedRetained();
    const alias = path.join(dir, path.basename(nfd).toUpperCase());
    if (caseInsensitive) {
      expect(() => store.assertSourceUnborrowed(alias)).toThrow("native custody");
    } else {
      expect(() => store.assertSourceUnborrowed(alias)).not.toThrow();
    }
    expect(detector).toHaveBeenCalled();
  },
);

it("unreadable normalization evidence refuses before sidecar creation", async () => {
  normalizationWitness();
  mapStat("lstatSync", (file) => {
    if (typeof file === "string" && path.basename(file).normalize("NFC") === "évidence") {
      throw Object.assign(new Error("modeled unreadable normalization evidence"), {
        code: "EACCES",
      });
    }
    return file;
  });
  seedRetained();
  await blockedConfig(/alias identity/);
});

it("preserves affirmative distinct target and sidecar objects (modeled sensitive lookup)", () => {
  const other = path.join(dir, "distinct");
  for (const file of [nfc, other]) {
    fs.writeFileSync(file, "{}");
    fs.writeFileSync(file + ".lock", "held-sidecar");
  }
  const files = [nfc, nfc + ".lock", other, other + ".lock"];
  preserveFiles(...files);
  mapStat("statSync", (file) =>
    file === nfd ? other : file === nfd + ".lock" ? other + ".lock" : file,
  );
  seedRetained();
  expect(() => store.assertSourceUnborrowed(nfd)).not.toThrow();
  expect(() => store.assertSourceUnborrowed(nfc)).toThrow("native custody");
});

it("preserves Unicode sidecar identity at final stale removal", async () => {
  sharedAlias(".lock");
  const parent = acquire();
  let calls = 0;
  await expect(
    acquireFileLock(nfd, {
      retries: retry,
      stale: 1,
      assertResourceUnborrowed(target) {
        if (++calls === 3) {
          seedRetained(parent);
        }
        store.assertSourceUnborrowed(target);
      },
    }),
  ).rejects.toThrow("native custody");
  expect(calls).toBe(3);
});

it("retains config and service sidecars when Unicode custody arises during an interval", async () => {
  const parent = acquire();
  const entered = vi.fn();
  const enter = async () => {
    entered();
    if (!fs.existsSync(nfc + ".lock")) {
      fs.linkSync(nfd + ".lock", nfc + ".lock");
    }
    const service = heldServiceLockCoordinate(fixture.root);
    const [config, alias] = preserveFiles(nfd + ".lock", nfc + ".lock", service + ".lock");
    expect(alias).toEqual(config);
    source.serviceKey = service;
    seedRetained(parent, "admitted");
    const nested = vi.fn(async () => undefined);
    await expect(withService(nested)).rejects.toThrow("native custody");
    expect(nested).not.toHaveBeenCalled();
  };
  await expect(withService(() => withConfigWriteLock(nfd, enter, {}))).rejects.toThrow(
    /native custody|release/,
  );
  expect(entered).toHaveBeenCalledOnce();
});
