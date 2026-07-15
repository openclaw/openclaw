import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({
  readWindowsProcessStartTimeSync: vi.fn<(pid: number, timeoutMs?: number) => number | null>(),
  getFileLockProcessStartTime: vi.fn<(pid: number) => number | null>(),
}));

vi.mock("./windows-port-pids.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-port-pids.js")>()),
  readWindowsProcessStartTimeSync: readers.readWindowsProcessStartTimeSync,
}));

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: readers.getFileLockProcessStartTime,
}));

const { readProcessStartTimeForOwnerIdentity } = await import("./process-owner-identity.js");

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
}

beforeEach(() => {
  readers.readWindowsProcessStartTimeSync.mockReset();
  readers.getFileLockProcessStartTime.mockReset();
});

afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

describe("readProcessStartTimeForOwnerIdentity", () => {
  it("reads Windows process creation time through the existing CIM/WMIC reader", () => {
    stubPlatform("win32");
    readers.readWindowsProcessStartTimeSync.mockReturnValue(1_752_000_000_000);

    expect(readProcessStartTimeForOwnerIdentity(4242)).toBe(1_752_000_000_000);
    expect(readers.readWindowsProcessStartTimeSync).toHaveBeenCalledWith(4242, 1000);
    // No procfs/ps probe is attempted on Windows.
    expect(readers.getFileLockProcessStartTime).not.toHaveBeenCalled();
  });

  it("reports Windows identity as unreadable rather than guessing", () => {
    stubPlatform("win32");
    readers.readWindowsProcessStartTimeSync.mockReturnValue(null);

    expect(readProcessStartTimeForOwnerIdentity(4242)).toBeNull();
  });

  it.each(["linux", "darwin"] as const)("keeps %s on the existing lock reader", (platform) => {
    stubPlatform(platform);
    readers.getFileLockProcessStartTime.mockReturnValue(900);

    expect(readProcessStartTimeForOwnerIdentity(4242)).toBe(900);
    expect(readers.getFileLockProcessStartTime).toHaveBeenCalledWith(4242);
    expect(readers.readWindowsProcessStartTimeSync).not.toHaveBeenCalled();
  });
});
