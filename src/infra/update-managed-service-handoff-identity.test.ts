import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { nativeBoundaryTestEntrypoints } from "./native-boundary-runtime.test-support.js";
import * as nodeSqlite from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const dirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed handoff Windows process identities", () => {
  it.each([
    { option: "--profile", args: ["--profile", "handoff-fixture"] },
    { option: "--dev", args: ["--dev"] },
  ])(
    "keeps original launcher attribution after $option normalization in a real child",
    async ({ args }) => {
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
      const child = spawn(
        process.execPath,
        [
          ...resolveRuntimeWorkerArgv(profileUrl).slice(0, -1),
          fixturePath,
          ...args,
          "update",
          "--yes",
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
      );
      const closed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      try {
        expect(await closed, stderr).toEqual([0, null]);
        expect(stdout).toBe("original launcher matched");
      } finally {
        child.kill("SIGKILL");
        await closed;
      }
    },
  );

  it("makes published strict readers refuse fallback leases without changing numeric identities", () => {
    // v2026.9.4's nested strict contract must reject an identity it could mistake for PID reuse.
    const publishedIdentity = z.strictObject({
      pid: z.number().int().positive(),
      startIdentity: z.string().min(1).max(128),
    });
    const startedAt = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(123);
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: {},
    });
    withMockedPlatform("win32", () => {
      const argv = ["C:\\node.exe", "C:\\openclaw\\entry.js"];
      expect(publishedIdentity.parse(store.processIdentity(42, argv))).toEqual({
        pid: 42,
        startIdentity: "123",
      });
      startedAt.mockReturnValue(null);
      const fallback = store.processIdentity(42, argv);
      expect(
        parseManagedHandoffLeasePayload(
          JSON.stringify({
            version: 2,
            helper: fallback,
            executor: fallback,
            action: { kind: "update" },
          }),
        ),
      ).not.toBeNull();
      expect(publishedIdentity.safeParse(fallback).success).toBe(false);
      const unguarded = { pid: fallback.pid, startIdentity: fallback.startIdentity };
      expect(
        parseManagedHandoffLeasePayload(
          JSON.stringify({
            version: 2,
            helper: unguarded,
            executor: unguarded,
            action: { kind: "update" },
          }),
        ),
      ).toBeNull();
    });
  });

  it("does not reclaim a live fallback lease when launcher attribution disagrees", async () => {
    const hostPlatform = process.platform;
    const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
    // SQLite remains on the host VFS while Windows process facts are simulated.
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
      existingUri(pathname, hostPlatform),
    );
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const dead = vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "C:\\node.exe C:\\different\\entry.js" });
    const root = dirs.make("handoff-live-attribution-");
    const databasePath = path.join(root, "handoff.sqlite");
    const store = createManagedHandoffLeaseStore({
      databasePath,
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
    });
    const identity = withMockedPlatform("win32", () =>
      store.processIdentity(42, ["C:\\node.exe", "C:\\openclaw\\entry.js"]),
    );
    createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .insertInto("managed_update_handoffs")
          .values({
            install_root: root,
            owner: "live-original",
            payload_json: JSON.stringify({
              version: 2,
              helper: identity,
              executor: identity,
              action: { kind: "update" },
            }),
            updated_at: Date.now(),
          }),
      ),
    );
    withMockedPlatform("win32", () => {
      expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
      expect(store.acquire(root, "replacement", { kind: "update" })).toMatchObject({
        kind: "busy",
        owner: "live-original",
      });
      dead.mockImplementation((pid) => pid === 42);
      expect(store.acquire(root, "replacement", { kind: "update" }).kind).toBe("acquired");
    });
  });

  it("binds a spawned process when its InteractiveToken session cannot read a creation time", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "" });
    const onProcessIdentityWarning = vi.fn();
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
      onProcessIdentityWarning,
    });

    await withMockedPlatform("win32", async () => {
      const identity = store.processIdentity(42, [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\openclaw\\dist\\entry.js",
        "gateway",
        "install",
        "--update-executor",
        "check",
        "--json",
      ]);
      expect(identity).toEqual({
        pid: 42,
        startIdentity: expect.stringMatching(/^win32-argv-sha256:[a-f0-9]{64}$/),
        startIdentitySource: "argv-sha256",
      });
      expect(onProcessIdentityWarning).toHaveBeenCalledWith(
        42,
        expect.stringContaining("launcher attribution"),
      );
    });
  });

  it.each(["plain", "%%", "^!"])(
    "requires observed launcher attribution with literal %s unless the caller retains live process custody",
    async (suffix) => {
      const dead = vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
      const argv = [
        "C:\\Program Files\\nodejs\\node.exe",
        `C:\\openclaw${suffix}\\dist\\entry.js`,
        "gateway",
        "install",
        "--update-executor",
        "check",
        "--json",
      ];
      let commandLine = `"c:/program files/nodejs/node.exe" "C:\\openclaw${suffix}\\dist\\entry.js" gateway install --update-executor check --json`;
      spawnSyncMock.mockImplementation((_command: string, args: string[]) => ({
        status: 0,
        stdout: args.some((arg) => arg.includes("CommandLine")) ? commandLine : "",
      }));
      const store = createManagedHandoffLeaseStore({
        databasePath: "unused-handoff-identity.sqlite",
        serviceManagerEnv: { SystemRoot: "C:\\Windows" },
      });

      await withMockedPlatform("win32", async () => {
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
    },
  );

  it("keeps known creation-time mismatches authoritative", async () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    const startedAt = vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(123);
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
    });
    await withMockedPlatform("win32", async () => {
      const identity = store.processIdentity(42, ["C:\\node.exe", "C:\\openclaw\\entry.js"]);
      expect(identity.startIdentity).toBe("123");
      expect(store.isProcessIdentityCurrent(identity)).toBe(true);
      startedAt.mockReturnValue(456);
      expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
      startedAt.mockReturnValue(null);
      expect(store.isProcessIdentityCurrent(identity, true)).toBe(false);
    });
  });

  it("attributes its own process and emits an unavailable-identity warning only once", async () => {
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
    const onProcessIdentityWarning = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
      onProcessIdentityWarning,
    });
    await withMockedPlatform("win32", async () => {
      const identity = store.processIdentity();
      expect(store.isProcessIdentityCurrent(identity)).toBe(true);
      expect(
        store.processIdentity(process.pid, [
          process.argv0,
          ...process.execArgv,
          ...process.argv.slice(1),
        ]),
      ).toEqual(identity);
      expect(onProcessIdentityWarning).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { name: "a prompt probe", probeMs: 25, available: true, acquired: true },
    { name: "a probe slower than one second", probeMs: 2_000, available: true, acquired: true },
    { name: "an unavailable creation time", probeMs: 25, available: false, acquired: false },
    { name: "an exhausted identity budget", probeMs: 10_000, available: true, acquired: false },
  ])("preserves lease ownership with $name", async ({ probeMs, available, acquired }) => {
    const createdAt = "2026-09-01T09:00:00.123Z";
    spawnSyncMock.mockImplementation(
      (_command: string, _args: string[], options: { timeout: number }) => {
        vi.advanceTimersByTime(Math.min(probeMs, options.timeout));
        const completed = available && probeMs <= options.timeout;
        return { status: completed ? 0 : 1, stdout: completed ? createdAt : "" };
      },
    );
    const store = createManagedHandoffLeaseStore({
      databasePath: "unused-handoff-identity.sqlite",
      serviceManagerEnv: { SystemRoot: "C:\\Windows" },
    });

    await withMockedPlatform("win32", async () => {
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
    const rows = new Map(chain.map((pid, i) => [pid, { parentPid: chain[i + 1] ?? 1, startedAt }]));
    rows.set(1, { parentPid: 0, startedAt });
    const executor = { pid: executorPid, startIdentity };
    const database = createManagedHandoffLeaseDatabase(databasePath);
    database(true, (db) =>
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .insertInto("managed_update_handoffs")
          .values({
            install_root: root,
            owner: "original-v1-helper",
            payload_json: JSON.stringify({ version: 1, pid: helperPid, startIdentity }),
            updated_at: 100,
          }),
      ),
    );
    const parent = store.readLegacyParent(root, executor);
    if (!parent) {
      throw new Error("expected the seeded v1 parent");
    }
    const probes: { failure?: string; output?: string; afterRead?: () => void } = {};
    const nativeReads: number[] = [];
    const read = (pid: number, field: string) => {
      nativeReads.push(pid);
      if (probes.failure) {
        throw Object.assign(new Error("native inspection unavailable"), { code: probes.failure });
      }
      const row = rows.get(pid);
      if (!row) {
        throw Object.assign(new Error("process missing"), { code: "ESRCH" });
      }
      const output =
        probes.output ??
        (field === "lstart="
          ? `${row.startedAt}\n`
          : field === "ppid="
            ? `${row.parentPid}\n`
            : `${pid} ${row.parentPid} ${row.startedAt}\n`);
      probes.afterRead?.();
      return output;
    };
    vi.spyOn(childProcess, "execFileSync").mockImplementation((_file, args) =>
      read(Number(args?.[3]), String(args?.[1])),
    );
    // Support the original per-field probes too: the cost assertion must fail on the old path.
    spawnSyncMock.mockImplementation((_file, args: string[]) => ({
      status: 0,
      stdout: read(Number(args[3]), String(args[1])),
      stderr: "",
    }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const hostPlatform = process.platform;
    const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
      existingUri(pathname, hostPlatform),
    );
    return {
      rows,
      probes,
      nativeReads,
      helperPid,
      executorPid,
      parent,
      kill,
      current() {
        const descriptor = Object.getOwnPropertyDescriptor(process, "ppid");
        Object.defineProperty(process, "ppid", { configurable: true, value: executorPid });
        try {
          return withMockedPlatform("darwin", () => store.current(parent));
        } finally {
          if (descriptor) {
            Object.defineProperty(process, "ppid", descriptor);
          }
        }
      },
      storedParent: () => store.readLegacyParent(root, executor),
      replaceRow() {
        database(true, (db) =>
          executeSqliteQuerySync(
            db,
            leaseQueries(db)
              .updateTable("managed_update_handoffs")
              .set({ owner: "replacement" })
              .where("install_root", "=", root),
          ),
        );
      },
    };
  }

  it("uses one native read for a direct v1 helper and refreshes on the very next validation", () => {
    const test = fixture(0);
    expect(test.current()).toBe(true);
    expect(test.nativeReads).toEqual([test.helperPid]);
    test.rows.set(test.helperPid, { parentPid: 1, startedAt: "Thu Sep 24 00:00:01 2026" });
    expect(test.current()).toBe(false);
    expect(test.nativeReads).toEqual([test.helperPid, test.helperPid]);
    expect(test.kill).toHaveBeenCalledWith(test.helperPid, 0);
    expect(test.storedParent()).toEqual(test.parent);
  });

  it.each(["helper", "executor"] as const)(
    "refuses a replaced %s birth on the next validation",
    (role) => {
      const test = fixture(3);
      expect(test.current()).toBe(true);
      const pid = role === "helper" ? test.helperPid : test.executorPid;
      const row = test.rows.get(pid)!;
      test.rows.set(pid, { ...row, startedAt: "Thu Sep 24 00:00:01 2026" });
      expect(test.current()).toBe(false);
      expect(test.nativeReads.length).toBe(8);
      expect(test.storedParent()).toEqual(test.parent);
    },
  );

  it("refuses a reparented executor without clearing the retained row", () => {
    const test = fixture();
    expect(test.current()).toBe(true);
    test.rows.get(test.executorPid)!.parentPid = 1;
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(test.parent);
  });

  it("rereads the exact row after capturing process facts", () => {
    const test = fixture();
    test.probes.afterRead = () => {
      test.probes.afterRead = undefined;
      test.replaceRow();
    };
    expect(test.current()).toBe(false);
    expect(test.storedParent()?.owner).toBe("replacement");
  });

  it.each(["ETIMEDOUT", "EPERM", "ENOBUFS", "ESRCH"])(
    "refuses incomplete %s inspection without reclaiming the legacy row",
    (failure) => {
      const test = fixture();
      test.probes.failure = failure;
      expect(test.current()).toBe(false);
      expect(test.storedParent()).toEqual(test.parent);
    },
  );

  it("refuses malformed process metadata without clearing the retained row", () => {
    const test = fixture();
    test.probes.output = "truncated process metadata";
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(test.parent);
  });

  it("retains the independent live-process check after reading a matching birth", () => {
    const test = fixture();
    test.kill.mockImplementation(() => {
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    expect(test.current()).toBe(false);
    expect(test.storedParent()).toEqual(test.parent);
  });

  it.each([
    { edges: 32, accepted: true, reads: 33 },
    { edges: 33, accepted: false, reads: 32 },
  ])(
    "preserves the direct-parent plus 32-edge bound ($edges edges)",
    ({ edges, accepted, reads }) => {
      const test = fixture(edges);
      expect(test.current()).toBe(accepted);
      expect(test.nativeReads).toHaveLength(reads);
      expect(new Set(test.nativeReads).size).toBe(reads);
    },
  );

  it("preserves PID 1 as a possible required ancestor", () => {
    const test = fixture(2, true);
    expect(test.current()).toBe(true);
    expect(test.nativeReads).toHaveLength(3);
  });

  it("refuses a cycle before the required helper", () => {
    const test = fixture(3);
    test.rows.get(test.executorPid + 1)!.parentPid = test.executorPid;
    expect(test.current()).toBe(false);
    expect(test.nativeReads).toEqual([test.executorPid, test.executorPid + 1]);
  });
});
