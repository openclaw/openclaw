import { describe, expect, it } from "vitest";
import {
  detectLinuxVolatileStateDir,
  formatLinuxVolatileStateDirWarning,
} from "./doctor-state-integrity.js";

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
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo,
      resolveRealPath: (targetPath) => targetPath,
    });

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

    expect(
      detectLinuxVolatileStateDir("/home/user/.openclaw", {
        platform: "linux",
        mountInfo,
        resolveRealPath: (targetPath) => targetPath,
      }),
    ).toMatchObject({
      mountPoint: "/home/user/.openclaw",
      fsType: "tmpfs",
    });
  });

  it.each([
    ["overlay", OVERLAY_MOUNT_INFO],
    ["ext4", EXT4_MOUNT_INFO],
  ])("does not flag %s filesystems", (_name, mountInfo) => {
    expect(
      detectLinuxVolatileStateDir("/home/user/.openclaw", {
        platform: "linux",
        mountInfo,
        resolveRealPath: (targetPath) => targetPath,
      }),
    ).toBeNull();
  });

  it("does not inspect mount information on non-Linux platforms", () => {
    expect(
      detectLinuxVolatileStateDir("/home/user/.openclaw", {
        platform: "darwin",
        mountInfo: TMPFS_MOUNT_INFO,
        resolveRealPath: (targetPath) => targetPath,
      }),
    ).toBeNull();
  });

  it("does not warn when mount information is unavailable", () => {
    expect(
      detectLinuxVolatileStateDir("/home/user/.openclaw", {
        platform: "linux",
        mountInfo: "",
        resolveRealPath: (targetPath) => targetPath,
      }),
    ).toBeNull();
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
