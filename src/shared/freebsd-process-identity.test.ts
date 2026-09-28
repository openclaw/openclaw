import nodeModule from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { loadNative, endianness } = vi.hoisted(() => ({
  loadNative: vi.fn(),
  endianness: vi.fn(),
}));
vi.mock("node:os", () => ({ endianness }));
vi.mock("./freebsd-process-identity-native.ts", () => ({
  loadFreeBsdProcessIdentityNative: loadNative,
}));

beforeEach(() => {
  vi.resetModules();
  loadNative.mockReset();
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  endianness.mockReset().mockReturnValue("LE");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const boot = Buffer.alloc(16);
  boot.writeBigInt64LE(1_700_000_000n);
  boot.writeBigInt64LE(700_001n, 8);
  const proc = Buffer.alloc(1088);
  proc.writeInt32LE(1088);
  proc.writeInt32LE(42, 72);
  proc.writeBigInt64LE(1_700_000_005n, 336);
  proc.writeBigInt64LE(900_003n, 344);
  const parts = [boot, proc, Buffer.from(boot)];
  let calls = 0;
  const sysctl = vi.fn(
    (_mib: readonly number[], _count: number, output: Buffer, actual: number[]) => {
      const part = parts[calls++ % parts.length]!;
      part.copy(output);
      actual[0] = part.length;
      return 0;
    },
  );
  const library = { func: vi.fn(() => sysctl) };
  const load = vi.fn(() => library);
  loadNative.mockReturnValue({ load });
  return { boot, proc, parts, sysctl, library, load };
}

async function read(pid = 42) {
  return withMockedPlatform("freebsd", async () => {
    const { readFreeBsdProcessStartTime } = await import("./freebsd-process-identity.js");
    return readFreeBsdProcessStartTime(pid);
  });
}

it.each(["x64", "arm64"] as const)("reads exact kernel microseconds on %s", async (arch) => {
  vi.spyOn(process, "arch", "get").mockReturnValue(arch);
  const { sysctl, load, library } = fixture();
  expect(await read()).toBe(5_200_002);
  expect(await read()).toBe(5_200_002);
  expect(loadNative).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledExactlyOnceWith(null);
  expect(library.func).toHaveBeenCalledTimes(1);
  expect(
    sysctl.mock.calls.slice(0, 3).map(([mib, count, output]) => [mib, count, output.length]),
  ).toEqual([
    [[1, 21], 2, 16],
    [[1, 14, 1, 42], 4, 1088],
    [[1, 21], 2, 16],
  ]);
});

it("keeps the identity stable when the boot offset and wall-clock start move together", async () => {
  const { parts } = fixture();
  expect(await read()).toBe(5_200_002);
  for (const [index, offset] of [
    [0, 0],
    [1, 336],
    [2, 0],
  ] as const) {
    const part = parts[index]!;
    part.writeBigInt64LE(part.readBigInt64LE(offset) + 60n, offset);
  }
  expect(await read()).toBe(5_200_002);
});

it.each([
  "changed boot bracket",
  "wrong struct size",
  "unknown layout",
  "wrong PID",
  "negative seconds",
  "negative microseconds",
  "microsecond overflow",
  "negative start",
  "unsafe start",
])("refuses %s without an identity approximation", async (variant) => {
  const { proc, parts } = fixture();
  if (variant === "changed boot bracket") {
    parts[2]!.writeBigInt64LE(700_002n, 8);
  }
  if (variant === "wrong struct size") {
    proc.writeInt32LE(1080);
  }
  if (variant === "unknown layout") {
    proc.writeInt32LE(1, 4);
  }
  if (variant === "wrong PID") {
    proc.writeInt32LE(43, 72);
  }
  if (variant === "negative seconds") {
    proc.writeBigInt64LE(-1n, 336);
  }
  if (variant === "negative microseconds") {
    proc.writeBigInt64LE(-1n, 344);
  }
  if (variant === "microsecond overflow") {
    proc.writeBigInt64LE(1_000_000n, 344);
  }
  if (variant === "negative start") {
    proc.writeBigInt64LE(0n, 336);
  }
  if (variant === "unsafe start") {
    proc.writeBigInt64LE(BigInt(Number.MAX_SAFE_INTEGER), 336);
  }
  expect(await read()).toBeNull();
});

it.each(
  [0, 1, 2].flatMap((failedCall) =>
    ["short", "long", "status"].map((failure) => ({ failedCall, failure })),
  ),
)("refuses $failure output from sysctl call $failedCall", async ({ failedCall, failure }) => {
  const { sysctl } = fixture();
  const successful = sysctl.getMockImplementation()!;
  let call = 0;
  sysctl.mockImplementation((mib, count, output, actual) => {
    const result = successful(mib, count, output, actual);
    if (call++ === failedCall) {
      if (failure === "status") {
        return -1;
      }
      actual[0]! += failure === "short" ? -1 : 1;
    }
    return result;
  });
  expect(await read()).toBeNull();
});

it("keeps ordinary sealed runtimes from invoking the installed native loader", async () => {
  const { loadFreeBsdProcessIdentityNative } = await vi.importActual<
    typeof import("./freebsd-process-identity-native.ts")
  >("./freebsd-process-identity-native.ts");
  const requireSpy = vi.spyOn(nodeModule, "createRequire");
  vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
  expect(loadFreeBsdProcessIdentityNative).toThrow("unavailable in this sealed runtime");
  expect(requireSpy).not.toHaveBeenCalled();
});

it("retries failed native loading and fails closed on native errors", async () => {
  const { sysctl } = fixture();
  loadNative.mockImplementationOnce(() => {
    throw new Error("native runtime missing");
  });
  expect(await read()).toBeNull();
  expect(await read()).toBe(5_200_002);
  sysctl.mockImplementationOnce(() => {
    throw new Error("sysctl failed");
  });
  expect(await read()).toBeNull();
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000])(
  "rejects invalid native PID %s before loading",
  async (pid) => {
    fixture();
    expect(await read(pid)).toBeNull();
    expect(loadNative).not.toHaveBeenCalled();
  },
);

it("does not load for other operating systems, architectures or byte orders", async () => {
  fixture();
  const { readFreeBsdProcessStartTime } = await import("./freebsd-process-identity.js");
  await withMockedPlatform("linux", async () => expect(readFreeBsdProcessStartTime(42)).toBeNull());
  vi.spyOn(process, "arch", "get").mockReturnValue("ia32");
  expect(await read()).toBeNull();
  vi.spyOn(process, "arch", "get").mockReturnValue("x64");
  endianness.mockReturnValue("BE");
  expect(await read()).toBeNull();
  expect(loadNative).not.toHaveBeenCalled();
});
