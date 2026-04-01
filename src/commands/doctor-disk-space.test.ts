import { describe, expect, it, vi } from "vitest";
import {
  buildDiskSpaceWarnings,
  findExistingAncestor,
  formatBytes,
  getAvailableBytes,
  noteDiskSpace,
} from "./doctor-disk-space.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("returns unknown for negative values", () => {
    expect(formatBytes(-1)).toBe("unknown");
  });

  it("returns unknown for NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown");
  });

  it("returns unknown for Infinity", () => {
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("findExistingAncestor", () => {
  it("returns the path itself when it exists", () => {
    const result = findExistingAncestor("/tmp");
    expect(result).toBe("/tmp");
  });

  it("returns parent when child does not exist", () => {
    const result = findExistingAncestor("/tmp/nonexistent-openclaw-test-dir-12345");
    expect(result).toBe("/tmp");
  });

  it("walks up multiple levels", () => {
    const result = findExistingAncestor("/tmp/nonexistent-a/nonexistent-b/nonexistent-c");
    expect(result).toBe("/tmp");
  });

  it("returns root for deeply nonexistent paths", () => {
    const result = findExistingAncestor("/nonexistent-openclaw-root-test/deep/path");
    expect(result).toBe("/");
  });
});

describe("getAvailableBytes", () => {
  it("returns available bytes from statfsSync", () => {
    const mockStatfs = vi.fn().mockReturnValue({ bavail: 1000n, bsize: 4096n });
    const result = getAvailableBytes("/some/path", { statfsSync: mockStatfs });
    expect(result).toBe(4096000);
  });

  it("returns null when statfsSync throws", () => {
    const mockStatfs = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const result = getAvailableBytes("/missing/path", { statfsSync: mockStatfs });
    expect(result).toBeNull();
  });

  it("probes ancestor when target dir does not exist", () => {
    const mockStatfs = vi.fn().mockReturnValue({ bavail: 500n, bsize: 4096n });
    const result = getAvailableBytes("/tmp/nonexistent-openclaw-test-dir-67890", {
      statfsSync: mockStatfs,
    });
    expect(result).toBe(2048000);
    // Should have been called with /tmp (the existing ancestor), not the nonexistent path
    expect(mockStatfs).toHaveBeenCalledWith("/tmp");
  });
});

describe("buildDiskSpaceWarnings", () => {
  it("returns empty array when space is sufficient", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 10 * 1024 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toEqual([]);
  });

  it("returns warning lines when space is low (below 500 MB)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 300 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Low disk space");
    expect(warnings[0]).toContain("300 MB");
    expect(warnings[0]).toContain("~/.openclaw");
  });

  it("returns critical lines when space is very low (below 100 MB)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 50 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
    expect(warnings[0]).toContain("50 MB");
  });

  it("returns critical at exactly 0 bytes", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 0,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
  });

  it("returns empty at exactly 500 MB (boundary)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 500 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toEqual([]);
  });

  it("returns warning at 499 MB (just below boundary)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 499 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Low disk space");
  });

  it("returns critical at exactly 99 MB (just below critical)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 99 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
  });
});

describe("noteDiskSpace", () => {
  it("calls note when space is below warning threshold", async () => {
    const { note: mockNote } = await import("../terminal/note.js");

    vi.mocked(mockNote).mockClear();

    const mockStatfs = vi.fn().mockReturnValue({ bavail: 100n, bsize: 1048576n });
    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      statfsSync: mockStatfs,
    });

    expect(mockNote).toHaveBeenCalledOnce();
    const [message, title] = vi.mocked(mockNote).mock.calls[0];
    expect(title).toBe("Disk space");
    expect(message).toContain("Low disk space");
  });

  it("does not call note when space is sufficient", async () => {
    const { note: mockNote } = await import("../terminal/note.js");

    vi.mocked(mockNote).mockClear();

    const mockStatfs = vi.fn().mockReturnValue({ bavail: 10000n, bsize: 1048576n });
    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      statfsSync: mockStatfs,
    });

    expect(mockNote).not.toHaveBeenCalled();
  });

  it("does not call note when statfsSync fails", async () => {
    const { note: mockNote } = await import("../terminal/note.js");

    vi.mocked(mockNote).mockClear();

    const mockStatfs = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      statfsSync: mockStatfs,
    });

    expect(mockNote).not.toHaveBeenCalled();
  });
});
