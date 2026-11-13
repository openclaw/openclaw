// Covers disk-space formatting and the package staging refusal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describePackageStagingShortfall,
  formatDiskSpaceBytes,
  tryReadDiskSpace,
} from "./disk-space.js";
import { createStatfsFixture as statfsFixture } from "./disk-space.test-support.js";

describe("disk-space helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads disk space from the nearest existing ancestor", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-space-"));
    try {
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(
        statfsFixture({
          bavail: 512,
          bsize: 1024,
          blocks: 4096,
        }),
      );

      const snapshot = tryReadDiskSpace(path.join(tempDir, "missing", "child"));

      expect(snapshot).toEqual({
        targetPath: path.join(tempDir, "missing", "child"),
        checkedPath: tempDir,
        availableBytes: 512 * 1024,
        totalBytes: 4096 * 1024,
      });
      expect(statfs).toHaveBeenCalledWith(tempDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses package staging below 1 GiB with the amount to free", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disk-space-"));
    try {
      const statfs = vi.spyOn(fs, "statfsSync");
      statfs.mockReturnValue(statfsFixture({ bavail: 256, bsize: 1024 * 1024 }));
      expect(describePackageStagingShortfall(tempDir)).toBe(
        `Update refused: 256 MiB free on the volume holding ${tempDir}; a package update needs about 1.0 GiB. Free 768 MiB there, then retry openclaw update. No changes were made.`,
      );
      statfs.mockReturnValue(statfsFixture({ bavail: 1024, bsize: 1024 * 1024 }));
      expect(describePackageStagingShortfall(tempDir)).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps byte formatting compact", () => {
    expect(formatDiskSpaceBytes(420 * 1024 * 1024)).toBe("420 MiB");
    expect(formatDiskSpaceBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
  });

  it("promotes MiB values that round up to 1024 into GiB", () => {
    // mib in [1023.5, 1024) rounds to 1024; must render as GiB, not "1024 MiB".
    expect(formatDiskSpaceBytes(Math.round(1023.6 * 1024 * 1024))).toBe("1.0 GiB");
    expect(formatDiskSpaceBytes(Math.round(1023.9 * 1024 * 1024))).toBe("1.0 GiB");
    expect(formatDiskSpaceBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
    // Just below the rounding boundary still reads as MiB.
    expect(formatDiskSpaceBytes(Math.round(1023.4 * 1024 * 1024))).toBe("1023 MiB");
  });
});
