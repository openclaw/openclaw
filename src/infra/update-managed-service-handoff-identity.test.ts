import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import type { ProcessAncestry } from "@openclaw/proc-safe/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { mockProcessPlatform, withMockedPlatform } from "../test-utils/vitest-spies.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { nativeBoundaryTestEntrypoints } from "./native-boundary-runtime.test-support.js";
import * as nodeSqlite from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  type LeaseTable,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLeaseStoreOptions } from "./update-managed-service-handoff-lease-types.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import {
  managedHandoffBootSchema,
  parseManagedHandoffLeasePayload,
} from "./update-managed-service-handoff-schema.js";

const { readProcessAncestry, readProcessIdentity } = vi.hoisted(() => ({
  readProcessAncestry: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
  readProcessIdentity: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessIdentity>(),
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
  readProcessIdentity,
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());
const dirs = useAutoCleanupTempDirTracker(afterEach);
const hostPlatform = process.platform;
const windowsArgv = ["C:\\node.exe", "C:\\openclaw\\entry.js"];
function windowsStore(options: Partial<ManagedHandoffLeaseStoreOptions> = {}) {
  return createManagedHandoffLeaseStore({
    databasePath: "unused-handoff-identity.sqlite",
    serviceManagerEnv: { SystemRoot: "C:\\Windows" },
    ...options,
  });
}
function useHostSqlite() {
  const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
  vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
    existingUri(pathname, hostPlatform),
  );
}
function seedLease(databasePath: string, row: LeaseTable) {
  createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
    executeSqliteQuerySync(db, leaseQueries(db).insertInto("managed_update_handoffs").values(row)),
  );
}
function leasePayload(helper: unknown) {
  return { version: 2, helper, executor: helper, action: { kind: "update" } };
}

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

beforeEach(() => {
  readProcessAncestry.mockReset().mockReturnValue(null);
  // Simulated platforms exercise diagnostic fallback, never the host kernel
  // identity of a coincidentally live fixture PID. Real children remain native.
  readProcessIdentity.mockReset().mockImplementation(() => {
    throw new ProcSafeError("helper-unavailable", "synthetic diagnostic fallback");
  });
  spawnSyncMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed handoff boot identities", () => {
  const bootBytes = Buffer.from("00ff018002fe037f04fd057e06fc077d", "hex");
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const timestamp = "2026-09-01T00:00:00.0000000Z";
  const serviceManagerEnv = { PATH: "/usr/bin:/bin" };
  const store = createManagedHandoffLeaseStore({
    databasePath: "/unused/managed-update-handoffs.sqlite",
    serviceManagerEnv,
  });
  it.each([
    ["freebsd", bootBytes.toString("hex"), "/sbin/sysctl", ["-b", "kern.boot_id"]],
    ["darwin", uuid, "/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
    [
      "win32",
      timestamp,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
      ],
    ],
  ] as const)("reads %s boot identity", async (platform, identity, command, args) => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: platform === "freebsd" ? bootBytes : `${identity}\n`,
    });
    await withMockedPlatform(platform, async () => {
      expect(store.bootIdentity()).toEqual({ platform, identity });
    });
    expect(spawnSyncMock).toHaveBeenCalledExactlyOnceWith(command, args, {
      env: serviceManagerEnv,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: platform === "win32" ? 5000 : 1000,
      ...(platform === "freebsd" ? { maxBuffer: 16 } : { encoding: "utf8", windowsHide: true }),
    });
  });
  it.each([
    { status: 0, stdout: Buffer.alloc(15) },
    { status: 0, stdout: Buffer.alloc(17) },
    { status: 0, stdout: "0123456789abcdef" },
    { status: 1, stdout: bootBytes },
    { status: 0, stdout: bootBytes, error: new Error("read failed") },
  ])("refuses an unavailable or incomplete FreeBSD boot token: %j", async (result) => {
    spawnSyncMock.mockReturnValue(result);
    await withMockedPlatform("freebsd", async () => {
      expect(() => store.bootIdentity()).toThrow(
        "OS boot identity unavailable; run openclaw triage manually",
      );
    });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
  it.each(["linux", "android"] as const)("reads %s boot IDs from procfs", async (platform) => {
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(`${uuid}\n`);
    await withMockedPlatform(platform, async () => {
      expect(store.bootIdentity()).toEqual({ platform: "linux", identity: uuid });
    });
    expect(read).toHaveBeenCalledWith("/proc/sys/kernel/random/boot_id", "utf8");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
  it("round-trips a strict FreeBSD foreground lease token", () => {
    const boot = { platform: "freebsd", identity: bootBytes.toString("hex") };
    const payload = {
      version: 2,
      executor: { pid: 100, startIdentity: "200" },
      helper: { pid: 101, startIdentity: "201" },
      action: { kind: "triage", phase: "reserved", lifetime: { kind: "foreground", boot } },
    };
    expect(parseManagedHandoffLeasePayload(JSON.stringify(payload))).toEqual(payload);
    for (const identity of [
      "",
      "00",
      "0".repeat(33),
      "g".repeat(32),
      boot.identity.toUpperCase(),
    ]) {
      expect(managedHandoffBootSchema.safeParse({ ...boot, identity }).success).toBe(false);
    }
    expect(managedHandoffBootSchema.safeParse({ ...boot, extra: true }).success).toBe(false);
  });
});

it("keeps original launcher attribution after profile normalization in a real child", async () => {
  vi.useRealTimers();
  const root = dirs.make("handoff-original-argv-");
  const fixturePath = path.join(root, "profile-identity.mjs");
  const profileUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.cliProfile);
  const identityUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.handoffProcess);
  fs.writeFileSync(
    fixturePath,
    `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import {syncBuiltinESMExports} from "node:module";
      import {parseCliProfileArgs} from ${JSON.stringify(profileUrl.href)};
      import {createManagedHandoffProcessIdentityReader} from ${JSON.stringify(identityUrl.href)};
      const originalArgv = process.report.getReport().header.commandLine;
      const parsed = parseCliProfileArgs(process.argv);
      assert(parsed.ok && parsed.profile);
      process.argv = parsed.argv;
      assert(!process.argv.includes("--profile") && !process.argv.includes("--dev"));
      assert.deepEqual(process.report.getReport().header.commandLine, originalArgv);
      childProcess.spawnSync = () => ({status: 0, stdout: "", stderr: ""});
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", {value: "win32"});
      const original = createManagedHandoffProcessIdentityReader({env: {SystemRoot: "C:\\\\Windows"}})
        .processIdentity(process.pid, originalArgv);
      const receiver = createManagedHandoffProcessIdentityReader({env: {SystemRoot: "C:\\\\Windows"}});
      assert.deepEqual(receiver.processIdentity(), original);
      assert.equal(receiver.isProcessIdentityCurrent(original), true);
      process.stdout.write("original launcher matched");
    `,
  );
  const { error, status, stdout, stderr } = await runNodeScript(
    [
      ...resolveRuntimeWorkerArgv(profileUrl).slice(0, -1),
      fixturePath,
      ..."--profile handoff-fixture update --yes".split(" "),
    ],
    process.env,
    10_000,
    { executable: process.execPath },
  );
  expect([error, status, stdout], stderr).toEqual([undefined, 0, "original launcher matched"]);
});

describe("managed handoff Windows process identities", () => {
  let store: ReturnType<typeof windowsStore>;
  beforeEach(() => {
    useHostSqlite();
    store = windowsStore();
    mockProcessPlatform("win32");
  });

  it("makes published strict readers refuse fallback leases without changing numeric identities", () => {
    // v2026.9.4's nested strict contract must reject an identity it could mistake for PID reuse.
    const publishedIdentity = z.strictObject({
      pid: z.number().int().positive(),
      startIdentity: z.string().min(1).max(128),
    });
    const startedAt = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(123);
    store = windowsStore({ serviceManagerEnv: {} });
    expect(publishedIdentity.parse(store.processIdentity(42, windowsArgv))).toEqual({
      pid: 42,
      startIdentity: "123",
    });
    startedAt.mockReturnValue(null);
    const fallback = store.processIdentity(42, windowsArgv);
    expect(parseManagedHandoffLeasePayload(JSON.stringify(leasePayload(fallback)))).not.toBeNull();
    expect(publishedIdentity.safeParse(fallback).success).toBe(false);
    const unguarded = { pid: fallback.pid, startIdentity: fallback.startIdentity };
    expect(parseManagedHandoffLeasePayload(JSON.stringify(leasePayload(unguarded)))).toBeNull();
  });

  it("does not reclaim a live fallback lease when launcher attribution disagrees", async () => {
    // SQLite remains on the host VFS while Windows process facts are simulated.
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const dead = vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "C:\\node.exe C:\\different\\entry.js" });
    const root = dirs.make("handoff-live-attribution-");
    const databasePath = path.join(root, "handoff.sqlite");
    store = windowsStore({ databasePath });
    const identity = store.processIdentity(42, windowsArgv);
    mockProcessPlatform(hostPlatform);
    seedLease(databasePath, {
      install_root: root,
      owner: "live-original",
      payload_json: JSON.stringify(leasePayload(identity)),
      updated_at: Date.now(),
    });
    mockProcessPlatform("win32");
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
    expect(store.acquire(root, "replacement", { kind: "update" })).toMatchObject({
      kind: "busy",
      owner: "live-original",
    });
    dead.mockImplementation((pid) => pid === 42);
    expect(store.acquire(root, "replacement", { kind: "update" }).kind).toBe("acquired");
  });

  it("requires observed launcher attribution unless the caller retains live process custody", async () => {
    const suffix = "%%^!";
    const dead = vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    const argv = [
      "C:\\Program Files\\nodejs\\node.exe",
      `C:\\openclaw${suffix}\\dist\\entry.js`,
      ..."gateway install --update-executor check --json".split(" "),
    ];
    let commandLine = `"c:/program files/nodejs/node.exe" "C:\\openclaw${suffix}\\dist\\entry.js" gateway install --update-executor check --json`;
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.some((arg) => arg.includes("CommandLine")) ? commandLine : "",
    }));
    const identity = store.processIdentity(42, argv);
    expect(store.isProcessIdentityCurrent(identity)).toBe(true);

    commandLine = commandLine.replace(" check ", " run ");
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);

    commandLine = "";
    expect(store.isProcessIdentityCurrent(identity)).toBe(false);
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(true);

    dead.mockReturnValue(true);
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
  });

  it("keeps known creation-time mismatches authoritative", async () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    const startedAt = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(123);
    const identity = store.processIdentity(42, windowsArgv);
    expect(identity.startIdentity).toBe("123");
    expect(store.isProcessIdentityCurrent(identity)).toBe(true);
    startedAt.mockReturnValue(456);
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
    startedAt.mockReturnValue(null);
    expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
  });

  it("attributes its own process and emits an unavailable-identity warning only once", async () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const onProcessIdentityWarning = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    store = windowsStore({ onProcessIdentityWarning });
    const identity = store.processIdentity();
    expect(store.isProcessIdentityCurrent(identity)).toBe(true);
    const launcher = [process.argv0, ...process.execArgv, ...process.argv.slice(1)];
    expect(store.processIdentity(process.pid, launcher)).toEqual(identity);
    expect(onProcessIdentityWarning).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "a probe slower than one second", probeMs: 2_000, available: true, acquired: true },
    { name: "an unavailable creation time", probeMs: 25, available: false, acquired: false },
    { name: "an exhausted identity budget", probeMs: 10_000, available: true, acquired: false },
  ])("preserves lease ownership with $name", async ({ probeMs, available, acquired }) => {
    const createdAt = "2026-09-01T09:00:00.123Z";
    spawnSyncMock.mockImplementation(
      (_command: string, _args: string[], { timeout }: { timeout: number }) => {
        vi.advanceTimersByTime(Math.min(probeMs, timeout));
        const completed = available && probeMs <= timeout;
        return { status: completed ? 0 : 1, stdout: completed ? createdAt : "" };
      },
    );
    if (acquired) {
      expect(store.processIdentity(42)).toEqual({
        pid: 42,
        startIdentity: String(Date.parse(createdAt)),
      });
    } else {
      expect(() => store.processIdentity(42)).toThrow(
        "managed handoff process start identity is unavailable",
      );
    }
  });
});

// These Darwin facts run through the real Unix lease store; Windows keeps its own VFS tests above.
describe.skipIf(process.platform === "win32")("managed handoff Darwin legacy validation", () => {
  function fixture(transitiveEdges = 1, helperIsInit = false) {
    const root = dirs.make("handoff-darwin-ancestry-");
    const databasePath = path.join(root, "handoff.sqlite");
    const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
    const chain = Array.from({ length: transitiveEdges + 1 }, (_, i) => process.pid + 10_000 + i);
    if (helperIsInit) {
      chain[chain.length - 1] = 1;
    }
    const executorPid = chain[0]!;
    const helperPid = chain.at(-1)!;
    const startedAt = "Thu Sep 24 00:00:00 2026";
    const startIdentity = String(Date.parse(`${startedAt} UTC`) / 1000);
    const executor = { pid: executorPid, startIdentity };
    const database = createManagedHandoffLeaseDatabase(databasePath);
    seedLease(databasePath, {
      install_root: root,
      owner: "original-v1-helper",
      payload_json: JSON.stringify({ version: 1, pid: helperPid, startIdentity }),
      updated_at: 100,
    });
    const parent = store.readLegacyParent(root, executor);
    assert(parent, "expected the seeded v1 parent");
    const identities = [process.pid, ...chain.filter((pid) => pid !== 1)].map((pid, index) => ({
      pid,
      parentPid: chain[index] ?? 1,
      startTimeMicros: Number(startIdentity) * 1_000_000,
      startTimeResolutionMicros: 1,
      exited: false,
    }));
    const ancestry: { -readonly [Key in keyof ProcessAncestry]: ProcessAncestry[Key] } = {
      chain: identities,
      complete: true,
      stoppedBy: helperIsInit ? "root" : "through-pid",
    };
    readProcessAncestry.mockReturnValue(ancestry);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    useHostSqlite();
    mockProcessPlatform("darwin");
    vi.spyOn(process, "ppid", "get").mockReturnValue(executorPid);
    return {
      identities,
      ancestry,
      helperPid,
      executorPid,
      parent,
      kill,
      current: () => store.current(parent),
      storedParent: () => store.readLegacyParent(root, executor),
      replaceRow() {
        database(true, (db) => {
          const query = leaseQueries(db).updateTable("managed_update_handoffs");
          executeSqliteQuerySync(
            db,
            query.set({ owner: "replacement" }).where("install_root", "=", root),
          );
        });
      },
    };
  }

  it.each([
    { name: "direct helper birth", edges: 0, change: "helper" },
    { name: "ancestor helper birth", edges: 3, change: "helper" },
    { name: "executor birth", edges: 3, change: "executor" },
    { name: "executor parent", edges: 1, change: "parent" },
  ] as const)("refreshes $name on the next validation", ({ edges, change }) => {
    const test = fixture(edges);
    expect(test.current()).toBe(true);
    const pid = change === "helper" ? test.helperPid : test.executorPid;
    const identity = test.identities.find((value) => value.pid === pid)!;
    if (change === "parent") {
      test.identities.splice(2);
      identity.parentPid = 1;
      test.ancestry.stoppedBy = "root";
    } else {
      identity.startTimeMicros += 1_000_000;
    }
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(test.parent);
  });

  it.each([
    ["replaced row", undefined],
    ["denied inspection", "access-denied"],
    ["malformed metadata", "layout-mismatch"],
    ["dead process", undefined],
    ["cycle", undefined],
  ] as const)("refuses %s without clearing the retained legacy row", (failure, error) => {
    const test = fixture(failure === "cycle" ? 3 : 1);
    if (error) {
      readProcessAncestry.mockImplementation(() => {
        throw new ProcSafeError(error, "synthetic process inspection failure");
      });
    } else if (failure === "replaced row") {
      readProcessAncestry.mockImplementationOnce(() => {
        test.replaceRow();
        return test.ancestry;
      });
    } else if (failure === "dead process") {
      test.kill.mockImplementation(() => {
        throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      });
    } else {
      Object.assign(test.ancestry, { complete: false, stoppedBy: "cycle" });
    }
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(
      failure === "replaced row" ? { ...test.parent, owner: "replacement" } : test.parent,
    );
  });

  it("does not authorize PID 1 as a borrowed helper", () => {
    const test = fixture(2, true);
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(test.parent);
  });
});
