import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { readBootId, resetBootIdCacheForTest } from "./boot-id.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

function mockBootIdRead(implementation: () => string) {
  const originalReadFileSync = fsSync.readFileSync;
  return vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, encoding) => {
    if (String(filePath) === BOOT_ID_PATH) {
      return implementation() as never;
    }
    return originalReadFileSync(filePath as never, encoding as never) as never;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetBootIdCacheForTest();
});

describe("readBootId", () => {
  it("returns the trimmed lowercase linux boot id", () => {
    mockBootIdRead(() => "5C7B9E0A-1F2D-4C3B-8A9E-0123456789AB\n");

    withMockedPlatform("linux", () => {
      expect(readBootId()).toBe("5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab");
    });
  });

  it("caches a successful read for the process lifetime", () => {
    const read = mockBootIdRead(() => "5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab\n");

    withMockedPlatform("linux", () => {
      expect(readBootId()).toBe("5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab");
      expect(readBootId()).toBe("5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab");
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries after an unreadable boot id instead of caching null", () => {
    let readable = false;
    mockBootIdRead(() => {
      if (!readable) {
        throw Object.assign(new Error("hidden"), { code: "EACCES" });
      }
      return "5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab\n";
    });

    withMockedPlatform("linux", () => {
      expect(readBootId()).toBeNull();
      readable = true;
      expect(readBootId()).toBe("5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab");
    });
  });

  it("rejects malformed boot id contents", () => {
    mockBootIdRead(() => "not-a-uuid\n");

    withMockedPlatform("linux", () => {
      expect(readBootId()).toBeNull();
    });
  });

  it.each(["darwin", "win32", "freebsd"] as const)("returns null on %s", (platform) => {
    const read = mockBootIdRead(() => "5c7b9e0a-1f2d-4c3b-8a9e-0123456789ab\n");

    withMockedPlatform(platform, () => {
      expect(readBootId()).toBeNull();
    });
    expect(read).not.toHaveBeenCalled();
  });
});
