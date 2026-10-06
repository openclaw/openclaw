import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import {
  detectLinuxVolatileStateDir,
  formatLinuxVolatileStateDirWarning,
} from "./doctor-state-integrity.js";

afterEach(() => vi.restoreAllMocks());

describe("detectLinuxVolatileStateDir", () => {
  const TMPFS_MOUNT_INFO = [
    "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw",
    "30 22 0:30 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw",
    "35 22 0:35 / /home/user/.openclaw rw - tmpfs tmpfs rw,size=1048576k",
  ].join("\n");
  const RAMFS_MOUNT_INFO = [
    "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw",
    "35 22 0:35 / /home/user/.openclaw rw - ramfs ramfs rw",
  ].join("\n");
  const OVERLAY_MOUNT_INFO = [
    "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/upper",
  ].join("\n");
  const EXT4_MOUNT_INFO = "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw";

  it.each([
    ["tmpfs", TMPFS_MOUNT_INFO],
    ["ramfs", RAMFS_MOUNT_INFO],
  ])("detects %s state directories", (fsType, mountInfo) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(mountInfo);
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((targetPath) => targetPath);
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw");

    expect(result).toMatchObject({
      path: "/home/user/.openclaw",
      mountPoint: "/home/user/.openclaw",
      fsType,
    });
  });

  it("uses the most specific matching mount", () => {
    const mountInfo = [
      "22 1 0:21 / / rw - ext4 /dev/sda1 rw",
      "30 22 0:30 / /home rw - ext4 /dev/sda2 rw",
      "35 30 0:35 / /home/user/.openclaw rw - tmpfs tmpfs rw",
    ].join("\n");

    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(mountInfo);
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((targetPath) => targetPath);
    expect(detectLinuxVolatileStateDir("/home/user/.openclaw")).toMatchObject({
      mountPoint: "/home/user/.openclaw",
      fsType: "tmpfs",
    });
  });

  it("detects a missing state directory through an existing symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-volatile-"));
    try {
      const volatileMount = path.join(root, "volatile");
      const stateLink = path.join(root, "state");
      fs.mkdirSync(volatileMount);
      fs.symlinkSync(volatileMount, stateLink, "dir");
      const resolvedVolatileMount = fs.realpathSync(volatileMount);

      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        [
          "22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw",
          `35 22 0:35 / ${resolvedVolatileMount} rw - tmpfs tmpfs rw`,
        ].join("\n"),
      );
      const result = detectLinuxVolatileStateDir(path.join(stateLink, "openclaw"));

      expect(result).toMatchObject({
        path: path.join(resolvedVolatileMount, "openclaw"),
        mountPoint: resolvedVolatileMount,
        fsType: "tmpfs",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["overlay", OVERLAY_MOUNT_INFO],
    ["ext4", EXT4_MOUNT_INFO],
  ])("does not flag %s filesystems", (_name, mountInfo) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(mountInfo);
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((targetPath) => targetPath);
    expect(detectLinuxVolatileStateDir("/home/user/.openclaw")).toBeNull();
  });

  it("does not inspect mount information on non-Linux platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const readFile = vi.spyOn(fs, "readFileSync");
    expect(detectLinuxVolatileStateDir("/home/user/.openclaw")).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not warn when mount information is unavailable", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("mountinfo unavailable");
    });
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((targetPath) => targetPath);
    expect(detectLinuxVolatileStateDir("/home/user/.openclaw")).toBeNull();
  });
});

describe("formatLinuxVolatileStateDirWarning", () => {
  it("covers all SQLite state and sidecar files under the volatile state directory", () => {
    const warning = formatLinuxVolatileStateDirWarning("~/.openclaw", {
      path: "/home/user/.openclaw",
      mountPoint: "/home/user/.openclaw",
      fsType: "tmpfs",
    });

    expect(warning).toContain("volatile filesystem");
    expect(warning).toContain("tmpfs");
    expect(warning).toContain("SQLite state");
    expect(warning).toContain("WAL/journal sidecars");
    expect(warning).toContain("lost on reboot");
    expect(warning).toContain("OPENCLAW_STATE_DIR");
  });
});
