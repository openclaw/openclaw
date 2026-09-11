import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withConfigWriteLock } from "../config/write-lock.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import {
  heldServiceLockCoordinate,
  seedRetainedBorrower,
  type RetainedBorrowerSource,
} from "../infra/update-retained-custody.test-support.js";
import { drainFileLockStateForTest, resetFileLockStateForTest } from "../plugin-sdk/file-lock.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";

const fixture = vi.hoisted(() => ({
  root: "",
  dead: false,
  nativeCalls: vi.fn(() => {
    throw new Error("Native execution forbidden in pure service borrower test");
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
  isPidDefinitelyDead: () => fixture.dead,
  getFileLockProcessStartTime: () => 123,
}));
vi.mock("../process/child-process-tree.js", () => ({ isChildProcessTreeAlive: () => false }));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => fixture.root,
}));

let env: NodeJS.ProcessEnv;
let source: RetainedBorrowerSource;
let installRoot: string;
let store: ReturnType<typeof createManagedHandoffLeaseStore>;

beforeEach(async () => {
  fixture.dead = false;
  fixture.nativeCalls.mockClear();
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "service-borrower-pure-")));
  fs.chmodSync(fixture.root, 0o700);
  env = { HOME: fixture.root, OPENCLAW_PROFILE: path.basename(fixture.root).toLowerCase() };
  installRoot = path.join(fixture.root, "install");
  fs.mkdirSync(installRoot);
  source = {
    runId: "run",
    transactionId: "transaction",
    claimId: "claim",
    revision: 1,
    recordSha256: "a".repeat(64),
    lifetimeId: "lifetime",
    serviceKey: await withGatewayServiceOperationLock(env, async () =>
      heldServiceLockCoordinate(fixture.root),
    ),
    configPaths: [path.join(fixture.root, "config.json")],
  };
  store = createManagedHandoffLeaseStore();
  resetFileLockStateForTest();
});
afterEach(async () => {
  await drainFileLockStateForTest();
  expect(fixture.nativeCalls).not.toHaveBeenCalled();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function acquire() {
  const result = store.acquire(installRoot, "run", { kind: "update" });
  if (result.kind !== "acquired") {
    throw new Error("fixture parent unavailable");
  }
  return result.lease;
}
function seedRetained(
  parent: ReturnType<typeof acquire>,
  phase: "reserved" | "admitted" = "reserved",
) {
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

function rowBytes() {
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
function sidecar(file = source.serviceKey) {
  const lockPath = file + ".lock";
  const stat = fs.lstatSync(lockPath);
  return { bytes: fs.readFileSync(lockPath), dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

it.each(["reserved", "admitted"] as const)(
  "refuses service acquisition with %s custody despite modeled parent absence",
  async (phase) => {
    const lease = seedRetained(acquire(), phase);
    fs.writeFileSync(
      source.serviceKey + ".lock",
      JSON.stringify({
        pid: 10000001,
        starttime: 1,
        createdAt: "2000-01-01T00:00:00Z",
      }),
    );
    const before = sidecar();
    const rows = rowBytes();
    fixture.dead = true;
    const mutate = vi.fn(async () => undefined);
    await expect(withGatewayServiceOperationLock(env, mutate)).rejects.toThrow("native custody");
    expect(mutate).not.toHaveBeenCalled();
    expect(store.release(lease)).toBe(false);
    expect(store.acquire(installRoot, "competitor", { kind: "update" })).toMatchObject({
      kind: "busy",
    });
    expect(sidecar()).toEqual(before);
    expect(rowBytes()).toBe(rows);
  },
);

it("reacquires a definitely dead ordinary service owner without rewriting custody", async () => {
  acquire();
  fs.writeFileSync(
    source.serviceKey + ".lock",
    JSON.stringify({ pid: 10000001, starttime: 123, createdAt: "2000-01-01T00:00:00Z" }),
  );
  const rows = rowBytes();
  fixture.dead = true;
  const mutate = vi.fn(async (assertCurrent: () => void) => {
    assertCurrent();
    expect(JSON.parse(sidecar().bytes.toString()).pid).toBe(process.pid);
  });
  await withGatewayServiceOperationLock(env, mutate);
  expect(mutate).toHaveBeenCalledOnce();
  expect(fs.existsSync(source.serviceKey + ".lock")).toBe(false);
  expect(rowBytes()).toBe(rows);
});

it.each(["reserved", "admitted"] as const)(
  "retains service and config sidecars at release with %s custody",
  async (phase) => {
    const parent = acquire();
    let beforeService: ReturnType<typeof sidecar> | undefined;
    let beforeConfig: ReturnType<typeof sidecar> | undefined;
    let rows = "";
    await expect(
      withGatewayServiceOperationLock(env, async (assertService) => {
        await withConfigWriteLock(
          source.configPaths[0]!,
          async () => {
            assertService();
            beforeService = sidecar();
            beforeConfig = sidecar(source.configPaths[0]!);
            seedRetained(parent, phase);
            rows = rowBytes();
            fixture.dead = true;
          },
          env,
          assertService,
        );
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: "File operation failed and lock release is unresolved",
      errors: [
        expect.objectContaining({ message: "Source resource has unresolved native custody." }),
        expect.objectContaining({ message: "Source resource has unresolved native custody." }),
      ],
      cause: expect.objectContaining({ message: "Source resource has unresolved native custody." }),
    });
    expect(sidecar()).toEqual(beforeService);
    expect(sidecar(source.configPaths[0]!)).toEqual(beforeConfig);
    expect(rowBytes()).toBe(rows);
  },
);

it("revokes held service assertions and blocks nested mutation after retained custody appears", async () => {
  const parent = acquire();
  const mutate = vi.fn(async () => undefined);
  let rows = "";
  let before: ReturnType<typeof sidecar> | undefined;
  const observations: unknown[] = [];
  await expect(
    withGatewayServiceOperationLock(env, async (assertService) => {
      before = sidecar();
      await withGatewayServiceOperationLock(env, async (assertNested) => {
        seedRetained(parent);
        rows = rowBytes();
        for (const assertCurrent of [assertService, assertNested]) {
          try {
            assertCurrent();
            observations.push("admitted");
          } catch (error) {
            observations.push(error);
          }
        }
        await expect(withGatewayServiceOperationLock(env, mutate)).rejects.toThrow(
          "native custody",
        );
      });
    }),
  ).rejects.toThrow("native custody");
  expect(observations).toHaveLength(2);
  for (const observation of observations) {
    expect(observation).toBeInstanceOf(Error);
    expect(String(observation)).toContain("native custody");
  }
  expect(mutate).not.toHaveBeenCalled();
  expect(sidecar()).toEqual(before);
  expect(rowBytes()).toBe(rows);
});

it.each(["service", "config"] as const)(
  "rechecks %s nested admission after the callback is queued",
  async (kind) => {
    const parent = acquire();
    const mutate = vi.fn(async () => undefined);
    let rows = "";
    let before: ReturnType<typeof sidecar> | undefined;
    let childResult: unknown;
    const lock = (operation: () => Promise<void>) =>
      kind === "service"
        ? withGatewayServiceOperationLock(env, operation)
        : withConfigWriteLock(source.configPaths[0]!, operation, env);
    const file = kind === "service" ? source.serviceKey : source.configPaths[0]!;
    await expect(
      lock(async () => {
        before = sidecar(file);
        const queued = lock(mutate).then(
          () => "admitted",
          (error: unknown) => error,
        );
        seedRetained(parent);
        rows = rowBytes();
        childResult = await queued;
      }),
    ).rejects.toThrow("native custody");
    expect(childResult).toBeInstanceOf(Error);
    expect(mutate).not.toHaveBeenCalled();
    expect(sidecar(file)).toEqual(before);
    expect(rowBytes()).toBe(rows);
  },
);

it.each(["reserved", "admitted"] as const)(
  "refuses an independent service interval while the original owner holds %s custody",
  async (phase) => {
    const parent = acquire();
    const entered = createDeferred();
    const finish = createDeferred();
    let before: ReturnType<typeof sidecar> | undefined;
    let rows = "";
    const owner = withGatewayServiceOperationLock(env, async () => {
      before = sidecar();
      seedRetained(parent, phase);
      rows = rowBytes();
      entered.resolve();
      await finish.promise;
    }).then(
      () => "released",
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      fixture.dead = true;
      const mutate = vi.fn(async () => undefined);
      // Called outside the original AsyncLocalStorage context, not reentrantly.
      await expect(withGatewayServiceOperationLock(env, mutate)).rejects.toThrow("native custody");
      expect(mutate).not.toHaveBeenCalled();
      expect(sidecar()).toEqual(before);
      expect(rowBytes()).toBe(rows);
    } finally {
      finish.resolve();
      expect(String(await owner)).toContain("native custody");
    }
    expect(sidecar()).toEqual(before);
    expect(rowBytes()).toBe(rows);
  },
);

it("joins previously admitted work before reporting unresolved release", async () => {
  const parent = acquire();
  const entered = createDeferred();
  const release = createDeferred();
  let joined = false;
  let closed = false;
  let rows = "";
  let before: ReturnType<typeof sidecar> | undefined;
  const owner = withGatewayServiceOperationLock(env, async () => {
    void withGatewayServiceOperationLock(env, async () => {
      entered.resolve();
      await release.promise;
      joined = true;
    }).catch(() => undefined);
    await entered.promise;
    before = sidecar();
    seedRetained(parent);
    rows = rowBytes();
  });
  const result = owner.then(
    () => {
      closed = true;
      return "released";
    },
    (error: unknown) => {
      closed = true;
      return error;
    },
  );
  try {
    await entered.promise;
    // Let the outer callback return while the admitted nested work is blocked.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(closed).toBe(false);
  } finally {
    release.resolve();
  }
  const error = await result;
  expect(joined).toBe(true);
  expect(String(error)).toContain("native custody");
  expect(sidecar()).toEqual(before);
  expect(rowBytes()).toBe(rows);
});

it.each(["missing", "unknown-phase", "unknown-version", "relative-source"] as const)(
  "retains incompatible historical custody (%s) without releasing a stale source",
  async (kind) => {
    const lease = seedRetained(acquire());
    const payload = {
      version: lease.version,
      executor: lease.executor,
      helper: lease.helper,
      action: lease.action,
      nativeBorrower: lease.nativeBorrower,
    };
    const invalid =
      kind === "missing"
        ? { ...payload, nativeBorrower: undefined }
        : kind === "unknown-version"
          ? { ...payload, version: 99 }
          : kind === "unknown-phase"
            ? { ...payload, nativeBorrower: { ...payload.nativeBorrower, phase: "unknown" } }
            : {
                ...payload,
                nativeBorrower: {
                  ...payload.nativeBorrower,
                  source: { ...source, serviceKey: "relative" },
                },
              };
    const db = new DatabaseSync(path.join(fixture.root, "managed-update-handoffs.sqlite"));
    try {
      db.prepare("UPDATE managed_update_handoffs SET payload_json=? WHERE install_root=?").run(
        JSON.stringify(invalid),
        installRoot,
      );
    } finally {
      db.close();
    }
    fs.writeFileSync(
      source.serviceKey + ".lock",
      JSON.stringify({ pid: 10000001, starttime: 123, createdAt: "2000-01-01T00:00:00Z" }),
    );
    const before = sidecar(),
      rows = rowBytes();
    fixture.dead = true;
    const mutate = vi.fn(async () => undefined);
    expect(store.read(installRoot)).toEqual({ kind: "unreadable" });
    await expect(withGatewayServiceOperationLock(env, mutate)).rejects.toThrow(/incompatible/);
    expect(mutate).not.toHaveBeenCalled();
    expect(store.release(lease)).toBe(false);
    expect(sidecar()).toEqual(before);
    expect(rowBytes()).toBe(rows);
  },
);

function seedDatabase(sql: string) {
  const file = path.join(fixture.root, "managed-update-handoffs.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  fs.chmodSync(file, 0o600);
  return file;
}

const unix = process.platform === "win32" ? it.skip : it;

// An interrupted first write leaves the store readable, because `open` creates it
// under the caller's umask before the store chmods it. Refusing that forever locked
// every install root out of config and service mutation on the host.
unix("repairs read-only mode drift and admits both lock owners", async () => {
  const file = seedDatabase("CREATE TABLE fixture_marker (id INTEGER PRIMARY KEY) STRICT");
  const config = source.configPaths[0]!;
  fs.writeFileSync(config, "before");
  fs.chmodSync(file, 0o644);

  expect(() => store.assertSourceUnborrowed(config)).not.toThrow();
  expect(fs.lstatSync(file).mode & 0o777).toBe(0o600);

  const mutateConfig = vi.fn(async () => fs.writeFileSync(config, "after"));
  await expect(withConfigWriteLock(config, mutateConfig, env)).resolves.toBeUndefined();
  expect(mutateConfig).toHaveBeenCalledTimes(1);

  const mutateService = vi.fn(async () => undefined);
  await expect(withGatewayServiceOperationLock(env, mutateService)).resolves.toBeUndefined();
  expect(mutateService).toHaveBeenCalledTimes(1);
});

function databaseSnapshot(file: string) {
  const { dev, ino, mode, size, mtimeMs } = fs.lstatSync(file);
  return { dev, ino, mode, size, mtimeMs, bytes: fs.readFileSync(file) };
}

it("admits ordinary source callbacks beside a healthy database without a handoff table", async () => {
  const file = seedDatabase("CREATE TABLE fixture_marker (id INTEGER PRIMARY KEY) STRICT");
  const config = source.configPaths[0]!;
  fs.writeFileSync(config, "before");
  const before = databaseSnapshot(file);
  const entries = fs.readdirSync(fixture.root).toSorted();
  expect(() => store.assertSourceUnborrowed(config)).not.toThrow();
  const mutateConfig = vi.fn(async () => fs.writeFileSync(config, "after"));
  await withConfigWriteLock(config, mutateConfig, env);
  const mutateService = vi.fn(async (assertCurrent: () => void) => assertCurrent());
  await withGatewayServiceOperationLock(env, mutateService);
  expect(mutateConfig).toHaveBeenCalledOnce();
  expect(mutateService).toHaveBeenCalledOnce();
  expect(fs.readFileSync(config, "utf8")).toBe("after");
  expect(databaseSnapshot(file)).toEqual(before);
  expect(fs.readdirSync(fixture.root).toSorted()).toEqual(entries);
});

it("keeps captured source inspection strict when the handoff table is missing", () => {
  const file = seedDatabase("CREATE TABLE fixture_marker (id INTEGER PRIMARY KEY) STRICT");
  const existingIdentity = captureManagedUpdateLeaseDatabaseIdentity(file);
  const captured = createManagedHandoffLeaseStore({
    databasePath: file,
    serviceManagerEnv: {},
    existingIdentity,
  });
  const before = databaseSnapshot(file);
  const entries = fs.readdirSync(fixture.root).toSorted();
  expect(() => captured.assertSourceUnborrowed(source.configPaths[0]!)).toThrow(
    /no such table: managed_update_handoffs/,
  );
  expect(databaseSnapshot(file)).toEqual(before);
  expect(fs.readdirSync(fixture.root).toSorted()).toEqual(entries);
});

it.each(
  (
    [
      "wrong-table",
      "wrong-view",
      "upper-case-table",
      "same-named-index",
      "corrupt",
      "unsafe-mode",
    ] as const
  ).filter((kind) => kind !== "unsafe-mode" || process.platform !== "win32"),
)("refuses %s storage without admitting source callbacks or repairing it", async (kind) => {
  const sql =
    kind === "wrong-table"
      ? "CREATE TABLE managed_update_handoffs (wrong TEXT) STRICT"
      : kind === "wrong-view"
        ? "CREATE VIEW managed_update_handoffs AS SELECT 1 AS wrong"
        : kind === "upper-case-table"
          ? "CREATE TABLE MANAGED_UPDATE_HANDOFFS (wrong TEXT) STRICT"
          : kind === "same-named-index"
            ? "CREATE TABLE fixture_marker (id INTEGER); CREATE INDEX managed_update_handoffs ON fixture_marker(id)"
            : "CREATE TABLE fixture_marker (id INTEGER PRIMARY KEY) STRICT";
  const file = seedDatabase(sql);
  if (kind === "corrupt") {
    fs.writeFileSync(file, "not a SQLite database");
  } else if (kind === "unsafe-mode") {
    // Group-writable: chmod cannot revoke a descriptor another user already holds,
    // so this stays unrepairable. Read-only drift is repaired, covered below.
    fs.chmodSync(file, 0o660);
  }
  const before = databaseSnapshot(file);
  const entries = fs.readdirSync(fixture.root).toSorted();
  const mutate = vi.fn(async () => undefined);
  expect(() => store.assertSourceUnborrowed(source.configPaths[0]!)).toThrow();
  await expect(withConfigWriteLock(source.configPaths[0]!, mutate, env)).rejects.toThrow();
  await expect(withGatewayServiceOperationLock(env, mutate)).rejects.toThrow();
  expect(mutate).not.toHaveBeenCalled();
  expect(databaseSnapshot(file)).toEqual(before);
  expect(fs.readdirSync(fixture.root).toSorted()).toEqual(entries);
});
