import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { collectDiskSpaceHealthFindings, formatBytes, noteDiskSpace } from "./doctor-disk-space.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

function collectFindingsAt(availableBytes: number) {
  return collectDiskSpaceHealthFindings({
    env: { HOME: "/home/test" },
    readDiskSpace: () => ({ availableBytes }),
  });
}

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [2048, "2 KB"],
    [2.5 * 1024 * 1024 * 1024, "2.5 GB"],
    [-1, "unknown"],
    [Number.NaN, "unknown"],
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("collectDiskSpaceHealthFindings", () => {
  it("returns critical at exactly 0 bytes", () => {
    expect(collectFindingsAt(0)).toEqual([
      expect.objectContaining({ target: "0 B", requirement: "critical-free-space" }),
    ]);
  });

  it("returns empty at exactly 500 MB", () => {
    expect(collectFindingsAt(500 * 1024 * 1024)).toEqual([]);
  });

  it("returns a low-space warning just below 500 MB", () => {
    expect(collectFindingsAt(499 * 1024 * 1024)).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/disk-space",
        severity: "warning",
        message: "Low disk space: 499 MB free on the partition containing /home/test/.openclaw.",
        path: "/home/test/.openclaw",
        target: "499 MB",
        requirement: "low-free-space",
        fixHint: expect.stringContaining("prevent future config/session write failures"),
      }),
    ]);
  });

  it("keeps sub-100 MB space critical without rounding the display across the threshold", () => {
    expect(collectFindingsAt(Math.floor(99.6 * 1024 * 1024))).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/disk-space",
        severity: "error",
        message: "CRITICAL: only 99 MB free on the partition containing /home/test/.openclaw.",
        path: "/home/test/.openclaw",
        target: "99 MB",
        requirement: "critical-free-space",
        fixHint: expect.stringContaining("avoid data loss"),
      }),
    ]);
  });

  it("returns no finding when disk space cannot be read", () => {
    expect(
      collectDiskSpaceHealthFindings({
        env: { HOME: "/home/test" },
        readDiskSpace: () => null,
      }),
    ).toEqual([]);
  });
});

describe("noteDiskSpace", () => {
  beforeEach(() => vi.mocked(note).mockClear());

  it("emits one titled low-space note", () => {
    noteDiskSpace({
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 300 * 1024 * 1024 }),
    });

    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Low disk space"),
      "Disk space",
    );
  });

  it.each([
    { name: "space is sufficient", snapshot: { availableBytes: 10 * 1024 * 1024 * 1024 } },
    { name: "disk space cannot be read", snapshot: null },
  ])("does not call note when $name", ({ snapshot }) => {
    noteDiskSpace({ env: { HOME: "/home/test" }, readDiskSpace: () => snapshot });
    expect(note).not.toHaveBeenCalled();
  });
});
