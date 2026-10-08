import childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const nativeKoffi = vi.hoisted(() => vi.fn());
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    createRequire: (url: string | URL) => {
      const require = original.createRequire(url);
      return (id: string) => (id === "koffi" ? nativeKoffi() : require(id));
    },
  };
});

const seconds = 1_790_000_000;
let bytes: Buffer;
const query = vi.fn();
const load = vi.fn();

function mockShellIdentity() {
  return vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  bytes = Buffer.alloc(136);
  bytes.writeUInt32LE(42, 12);
  bytes.writeUInt32LE(7, 16);
  bytes.writeBigUInt64LE(BigInt(seconds), 120);
  bytes.writeBigUInt64LE(999_999n, 128);
  query.mockReset().mockImplementation((_pid, _flavor, _arg, output: Buffer) => {
    bytes.copy(output);
    return bytes.length;
  });
  load.mockReset().mockReturnValue({ func: () => query });
  nativeKoffi.mockReset().mockReturnValue({ load });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads fresh Darwin identities without process startup on arm64", async () => {
  const shell = vi.spyOn(childProcess, "execFileSync");
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42)).toBe(seconds);
  bytes.writeBigUInt64LE(BigInt(seconds + 1), 120);
  bytes.writeUInt32LE(8, 16);
  expect(getFileLockProcessStartTime(42)).toBe(seconds + 1);
  expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 8, startedAt: seconds + 1 });
  expect(shell).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledExactlyOnceWith("/usr/lib/libproc.dylib");
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[0]).toEqual([42, 3, 0, expect.any(Buffer), 136]);
});

it("refuses custody signaling after a same-second Darwin process replacement", async () => {
  const shell = vi.spyOn(childProcess, "execFileSync");
  const { getFileLockProcessStartTime, getProcessInstanceStartTime } =
    await import("./pid-alive.js");
  const { settleCommandProcessGroups } = await import("../process/command-process-custody.js");
  const groups = await import("../process/child-process-tree.js");
  const termination = await import("../process/kill-tree.js");
  vi.spyOn(groups, "isChildProcessTreeAlive").mockReturnValueOnce(true).mockReturnValue(false);
  const kill = vi.spyOn(termination, "killProcessTree").mockReturnValue(undefined);

  const pid = process.pid + 1;
  bytes.writeUInt32LE(pid, 12);
  bytes.writeBigUInt64LE(123_456n, 128);
  const startedAt = getProcessInstanceStartTime(pid);
  expect(startedAt).toBe(seconds * 1_000_000 + 123_456);
  expect(getFileLockProcessStartTime(pid)).toBe(seconds);
  bytes.writeBigUInt64LE(123_457n, 128);
  expect(getFileLockProcessStartTime(pid)).toBe(seconds);
  expect(getProcessInstanceStartTime(pid)).toBe(seconds * 1_000_000 + 123_457);
  expect(await settleCommandProcessGroups([{ pid, startedAt }])).toMatchObject({
    settled: false,
    pids: [pid],
    reason: expect.stringContaining("Recorded process identity could not be confirmed"),
  });
  expect(kill).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
});

it("refuses an unsafe microsecond identity without changing the lease timestamp", async () => {
  const shell = vi.spyOn(childProcess, "execFileSync");
  const { getFileLockProcessStartTime, getProcessInstanceStartTime } =
    await import("./pid-alive.js");
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  bytes.writeBigUInt64LE(maximum / 1_000_000n, 120);
  bytes.writeBigUInt64LE(maximum % 1_000_000n, 128);
  expect(getProcessInstanceStartTime(42)).toBe(Number.MAX_SAFE_INTEGER);
  bytes.writeBigUInt64LE((maximum % 1_000_000n) + 1n, 128);
  expect(getProcessInstanceStartTime(42)).toBeNull();
  expect(getFileLockProcessStartTime(42)).toBe(Number(maximum / 1_000_000n));
  expect(shell).not.toHaveBeenCalled();
});

it.each<[string, () => void]>([
  ["x64", () => vi.spyOn(process, "arch", "get").mockReturnValue("x64")],
  ["sealed runtime", () => vi.stubGlobal("SEALED_RUNTIME_BUILD", true)],
])("keeps %s on the bounded shell path without loading Koffi", async (_name, configure) => {
  configure();
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockReturnValue("Thu Sep 24 00:00:00 2026\n");
  const { getFileLockProcessStartTime, getProcessInstanceStartTime } =
    await import("./pid-alive.js");
  expect(getProcessInstanceStartTime(42)).toBeNull();
  expect(shell).not.toHaveBeenCalled();
  expect(getFileLockProcessStartTime(42)).toBe(Date.UTC(2026, 8, 24) / 1000);
  expect(nativeKoffi).not.toHaveBeenCalled();
});

it.each<[string, () => void]>([
  ["short read", () => query.mockReturnValue(135)],
  ["wrong PID", () => bytes.writeUInt32LE(43, 12)],
  ["invalid parent", () => bytes.writeUInt32LE(0xffffffff, 16)],
  ["zero start", () => bytes.writeBigUInt64LE(0n, 120)],
  ["unsafe start", () => bytes.writeBigUInt64LE(2n ** 53n, 120)],
  ["invalid microseconds", () => bytes.writeBigUInt64LE(1_000_000n, 128)],
  [
    "query error",
    () =>
      query.mockImplementation(() => {
        throw new Error("denied");
      }),
  ],
  [
    "missing native package",
    () =>
      nativeKoffi.mockImplementation(() => {
        throw new Error("unavailable");
      }),
  ],
])("uses the bounded shell fallback after %s", async (_name, failNative) => {
  failNative();
  const shell = mockShellIdentity();
  const { getFileLockProcessStartTime, getProcessInstanceStartTime, readDarwinProcessIdentity } =
    await import("./pid-alive.js");
  const expected = Date.UTC(2026, 8, 24) / 1000;
  expect(getProcessInstanceStartTime(42)).toBeNull();
  expect(shell).not.toHaveBeenCalled();
  expect(getFileLockProcessStartTime(42)).toBe(expected);
  expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: expected });
  expect(shell).toHaveBeenCalledTimes(2);
  for (const call of shell.mock.calls) {
    expect(call[2]?.timeout).toBeGreaterThan(0);
    expect(call[2]?.timeout).toBeLessThanOrEqual(1000);
  }
  shell.mockImplementation(() => {
    throw new Error("process absent");
  });
  expect(getFileLockProcessStartTime(42)).toBeNull();
  expect(readDarwinProcessIdentity(42)).toBeNull();
});

it("retries a failed native load without caching a missing process", async () => {
  nativeKoffi.mockImplementationOnce(() => {
    throw new Error("native package unavailable");
  });
  const shell = vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
    throw new Error("absent");
  });
  const { getFileLockProcessStartTime } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42)).toBeNull();
  expect(getFileLockProcessStartTime(42)).toBe(seconds);
  expect(shell).toHaveBeenCalledTimes(1);
});

it.each<[number, number | undefined, number | null]>([
  [1500, undefined, 1000],
  [600, 1000, 400],
  [1000, 1000, null],
])(
  "bounds shell recovery after %sms native loading with allowance %s",
  async (elapsed, allowance, timeout) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    nativeKoffi.mockImplementation(() => {
      now += elapsed;
      throw new Error("native unavailable");
    });
    const shell = mockShellIdentity();
    const { getFileLockProcessStartTime, readDarwinProcessIdentity } =
      await import("./pid-alive.js");
    expect(getFileLockProcessStartTime(42, process.env, allowance)).toBe(
      timeout === null ? null : Date.UTC(2026, 8, 24) / 1000,
    );
    expect(readDarwinProcessIdentity(42, process.env, allowance)).toEqual(
      timeout === null ? null : { parentPid: 7, startedAt: Date.UTC(2026, 8, 24) / 1000 },
    );
    if (timeout === null) {
      expect(shell).not.toHaveBeenCalled();
    } else {
      expect(shell).toHaveBeenCalledTimes(2);
      for (const call of shell.mock.calls) {
        expect(call[2]?.timeout).toBe(timeout);
      }
    }
  },
);

it.each([0, 1.5])("rejects invalid PID %s before native conversion", async (pid) => {
  const shell = vi.spyOn(childProcess, "execFileSync");
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(pid)).toBeNull();
  expect(readDarwinProcessIdentity(pid)).toBeNull();
  expect(nativeKoffi).not.toHaveBeenCalled();
  expect(shell).not.toHaveBeenCalled();
});
