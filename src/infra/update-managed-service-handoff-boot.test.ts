import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import {
  managedHandoffBootSchema,
  parseManagedHandoffLeasePayload,
} from "./update-managed-service-handoff-schema.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));

const bootBytes = Buffer.from("00ff018002fe037f04fd057e06fc077d", "hex");
const serviceManagerEnv = { PATH: "/usr/bin:/bin" };
const store = createManagedHandoffLeaseStore({
  databasePath: "/unused/managed-update-handoffs.sqlite",
  serviceManagerEnv,
});

beforeEach(() => spawnSyncMock.mockReset());
afterEach(() => vi.restoreAllMocks());

it.each([
  {
    platform: "freebsd",
    stdout: bootBytes,
    identity: bootBytes.toString("hex"),
    command: "/sbin/sysctl",
    args: ["-b", "kern.boot_id"],
    options: { maxBuffer: 16, timeout: 1000 },
  },
  {
    platform: "darwin",
    stdout: "12345678-1234-1234-1234-123456789abc\n",
    identity: "12345678-1234-1234-1234-123456789abc",
    command: "/usr/sbin/sysctl",
    args: ["-n", "kern.bootsessionuuid"],
    options: { encoding: "utf8", windowsHide: true, timeout: 1000 },
  },
  {
    platform: "win32",
    stdout: "2026-09-01T00:00:00.0000000Z\n",
    identity: "2026-09-01T00:00:00.0000000Z",
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
    ],
    options: { encoding: "utf8", windowsHide: true, timeout: 5000 },
  },
] as const)(
  "preserves the $platform native boot query and identity",
  async ({ platform, stdout, identity, command, args, options }) => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout });
    await withMockedPlatform(platform, async () => {
      expect(store.bootIdentity()).toEqual({
        platform,
        identity,
      });
    });
    expect(spawnSyncMock).toHaveBeenCalledExactlyOnceWith(command, args, {
      env: serviceManagerEnv,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    });
  },
);

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

it("keeps Linux boot IDs on their existing procfs path", async () => {
  const identity = "12345678-1234-1234-1234-123456789abc";
  const read = vi.spyOn(fs, "readFileSync").mockReturnValue(`${identity}\n`);
  await withMockedPlatform("linux", async () => {
    expect(store.bootIdentity()).toEqual({ platform: "linux", identity });
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
  for (const identity of ["", "00", "0".repeat(33), "g".repeat(32), boot.identity.toUpperCase()]) {
    expect(managedHandoffBootSchema.safeParse({ ...boot, identity }).success).toBe(false);
  }
  expect(managedHandoffBootSchema.safeParse({ ...boot, extra: true }).success).toBe(false);
});
