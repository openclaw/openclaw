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

it.each(["arm64", "x64"] as const)(
  "reads fresh Darwin identities without process startup on %s",
  async (arch) => {
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    const shell = vi.spyOn(childProcess, "execFileSync");
    const { getFileLockProcessStartTime, readDarwinProcessIdentity } =
      await import("./pid-alive.js");
    expect(getFileLockProcessStartTime(42)).toBe(seconds);
    bytes.writeBigUInt64LE(BigInt(seconds + 1), 120);
    bytes.writeUInt32LE(8, 16);
    expect(getFileLockProcessStartTime(42)).toBe(seconds + 1);
    expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 8, startedAt: seconds + 1 });
    expect(shell).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledExactlyOnceWith("/usr/lib/libproc.dylib");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]).toEqual([42, 3, 0, expect.any(Buffer), 136]);
  },
);

it.each([
  "short read",
  "wrong PID",
  "invalid parent",
  "zero start",
  "unsafe start",
  "invalid microseconds",
  "query error",
  "missing native package",
])("uses the bounded shell fallback after %s", async (failure) => {
  if (failure === "short read") {
    query.mockReturnValue(135);
  }
  if (failure === "wrong PID") {
    bytes.writeUInt32LE(43, 12);
  }
  if (failure === "invalid parent") {
    bytes.writeUInt32LE(0xffffffff, 16);
  }
  if (failure === "zero start") {
    bytes.writeBigUInt64LE(0n, 120);
  }
  if (failure === "unsafe start") {
    bytes.writeBigUInt64LE(2n ** 53n, 120);
  }
  if (failure === "invalid microseconds") {
    bytes.writeBigUInt64LE(1_000_000n, 128);
  }
  if (failure === "query error") {
    query.mockImplementation(() => {
      throw new Error("denied");
    });
  }
  if (failure === "missing native package") {
    nativeKoffi.mockImplementation(() => {
      throw new Error("unavailable");
    });
  }
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  const expected = Date.UTC(2026, 8, 24) / 1000;
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

it("keeps sealed helpers independent of installed native packages", async () => {
  vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
  vi.spyOn(childProcess, "execFileSync").mockReturnValue("Thu Sep 24 00:00:00 2026\n");
  const { getFileLockProcessStartTime } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42)).toBe(Date.UTC(2026, 8, 24) / 1000);
  expect(nativeKoffi).not.toHaveBeenCalled();
});

it("preserves default shell recovery after slow native loading fails", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  nativeKoffi.mockImplementation(() => {
    now += 1500;
    throw new Error("native unavailable");
  });
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  const expected = Date.UTC(2026, 8, 24) / 1000;
  expect(getFileLockProcessStartTime(42)).toBe(expected);
  expect(readDarwinProcessIdentity(42)).toEqual({ parentPid: 7, startedAt: expected });
  expect(shell).toHaveBeenCalledTimes(2);
  for (const call of shell.mock.calls) {
    expect(call[2]?.timeout).toBe(1000);
  }
});

it.each([600, 1000])("charges %sms native loading to an explicit deadline", async (elapsed) => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  nativeKoffi.mockImplementation(() => {
    now += elapsed;
    throw new Error("native unavailable");
  });
  const shell = vi
    .spyOn(childProcess, "execFileSync")
    .mockImplementation((_file, args) =>
      args?.[1] === "lstart=" ? "Thu Sep 24 00:00:00 2026\n" : "42 7 Thu Sep 24 00:00:00 2026\n",
    );
  const { getFileLockProcessStartTime, readDarwinProcessIdentity } = await import("./pid-alive.js");
  expect(getFileLockProcessStartTime(42, process.env, 1000)).toBe(
    elapsed === 1000 ? null : Date.UTC(2026, 8, 24) / 1000,
  );
  expect(readDarwinProcessIdentity(42, process.env, 1000)).toEqual(
    elapsed === 1000 ? null : { parentPid: 7, startedAt: Date.UTC(2026, 8, 24) / 1000 },
  );
  if (elapsed === 1000) {
    expect(shell).not.toHaveBeenCalled();
  } else {
    expect(shell).toHaveBeenCalledTimes(2);
    for (const call of shell.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 400 });
    }
  }
});

it.each([0, -1, 1.5, Number.NaN, Infinity])(
  "rejects invalid PID %s before native conversion",
  async (pid) => {
    const shell = vi.spyOn(childProcess, "execFileSync");
    const { getFileLockProcessStartTime, readDarwinProcessIdentity } =
      await import("./pid-alive.js");
    expect(getFileLockProcessStartTime(pid)).toBeNull();
    expect(readDarwinProcessIdentity(pid)).toBeNull();
    expect(nativeKoffi).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  },
);
