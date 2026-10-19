import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import * as diskSpace from "../infra/disk-space.js";
import { collectDiskSpaceHealthFindings, formatBytes, noteDiskSpace } from "./doctor-disk-space.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", "/home/test/.openclaw");
  vi.stubEnv("OPENCLAW_HOME", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockDiskSpace(availableBytes: number) {
  vi.spyOn(diskSpace, "tryReadDiskSpace").mockReturnValue({
    availableBytes,
    targetPath: "/home/test/.openclaw",
    checkedPath: "/home/test",
    totalBytes: null,
  });
}

function collectFindingsAt(availableBytes: number) {
  mockDiskSpace(availableBytes);
  return collectDiskSpaceHealthFindings();
}

describe("formatBytes", () => {
  it.each([
    [2.5 * 1024 * 1024 * 1024, "2.5 GB"],
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
});

describe("noteDiskSpace", () => {
  beforeEach(() => vi.mocked(note).mockClear());

  it("emits one titled low-space note", () => {
    mockDiskSpace(300 * 1024 * 1024);
    noteDiskSpace();

    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Low disk space"),
      "Disk space",
    );
  });

  it("does not call note when space is sufficient", () => {
    mockDiskSpace(10 * 1024 * 1024 * 1024);
    noteDiskSpace();
    expect(note).not.toHaveBeenCalled();
  });
});
