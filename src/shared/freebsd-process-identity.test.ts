import nodeModule from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

const { loadNative, readProcessIdentity } = vi.hoisted(() => ({
  loadNative: vi.fn(),
  readProcessIdentity: vi.fn(),
}));
vi.mock("./freebsd-process-identity-native.ts", () => ({
  loadFreeBsdProcessIdentityNative: loadNative,
}));

beforeEach(() => {
  loadNative.mockReset().mockReturnValue({ readProcessIdentity });
  readProcessIdentity.mockReset().mockReturnValue({
    pid: 42,
    startTimeMicros: 1_700_000_005_900_003,
    startTimeSinceBootMicros: 5_200_002,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function read(pid = 42) {
  return withMockedPlatform("freebsd", async () => {
    const { readFreeBsdProcessStartTime } = await import("./freebsd-process-identity.js");
    return readFreeBsdProcessStartTime(pid);
  });
}

it("preserves the released microsecond identity and refreshes foreign observations", async () => {
  expect(await read()).toBe(5_200_002);
  readProcessIdentity.mockReturnValueOnce({ startTimeSinceBootMicros: 6_300_004 });
  expect(await read()).toBe(6_300_004);
});

it.each([null, { startTimeMicros: 1_700_000_005_900_003 }])(
  "does not substitute an epoch identity when the boot-relative identity is unavailable: %s",
  async (identity) => {
    readProcessIdentity.mockReturnValue(identity);
    expect(await read()).toBeNull();
  },
);

it("keeps ordinary sealed runtimes from invoking the installed native loader", async () => {
  const { loadFreeBsdProcessIdentityNative } = await vi.importActual<
    typeof import("./freebsd-process-identity-native.ts")
  >("./freebsd-process-identity-native.ts");
  const requireSpy = vi.spyOn(nodeModule, "createRequire");
  vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
  expect(loadFreeBsdProcessIdentityNative).toThrow("unavailable in this sealed runtime");
  expect(requireSpy).not.toHaveBeenCalled();
});

it("fails closed on unavailable or uncertain native observations", async () => {
  loadNative.mockImplementationOnce(() => {
    throw new Error("native runtime missing");
  });
  expect(await read()).toBeNull();
  expect(await read()).toBe(5_200_002);
  readProcessIdentity.mockImplementationOnce(() => {
    throw new Error("process visibility denied");
  });
  expect(await read()).toBeNull();
});

it.each([0, 1.5, 0x80000000])("rejects invalid native PID %s before loading", async (pid) => {
  expect(await read(pid)).toBeNull();
  expect(loadNative).not.toHaveBeenCalled();
});

it("does not load on other operating systems", async () => {
  const { readFreeBsdProcessStartTime } = await import("./freebsd-process-identity.js");
  await withMockedPlatform("linux", async () => expect(readFreeBsdProcessStartTime(42)).toBeNull());
  expect(loadNative).not.toHaveBeenCalled();
});
