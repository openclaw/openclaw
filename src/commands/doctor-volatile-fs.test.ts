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

  const EXT4_MOUNT_INFO = ["22 1 0:21 / / rw,relatime - ext4 /dev/sda1 rw"].join("\n");

  const OVERLAY_MOUNT_INFO = [
    "22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/lower,upperdir=/upper",
  ].join("\n");

  it("detects tmpfs state directory", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo: TMPFS_MOUNT_INFO,
      resolveRealPath: (p) => p,
    });
    expect(result).not.toBeNull();
    expect(result!.fsType).toBe("tmpfs");
    expect(result!.mountPoint).toBe("/home/user/.openclaw");
  });

  it("detects ramfs state directory", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo: RAMFS_MOUNT_INFO,
      resolveRealPath: (p) => p,
    });
    expect(result).not.toBeNull();
    expect(result!.fsType).toBe("ramfs");
  });

  it("does not flag overlay filesystem (Docker overlay2 survives host reboot)", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo: OVERLAY_MOUNT_INFO,
      resolveRealPath: (p) => p,
    });
    expect(result).toBeNull();
  });

  it("returns null for ext4 filesystem", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo: EXT4_MOUNT_INFO,
      resolveRealPath: (p) => p,
    });
    expect(result).toBeNull();
  });

  it("returns null on non-linux platforms", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "darwin",
      mountInfo: TMPFS_MOUNT_INFO,
      resolveRealPath: (p) => p,
    });
    expect(result).toBeNull();
  });

  it("returns null when mountInfo is unavailable", () => {
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo: "",
      resolveRealPath: (p) => p,
    });
    expect(result).toBeNull();
  });

  it("picks most specific mount point", () => {
    const mountInfo = [
      "22 1 0:21 / / rw - ext4 /dev/sda1 rw",
      "30 22 0:30 / /home rw - ext4 /dev/sda2 rw",
      "35 30 0:35 / /home/user/.openclaw rw - tmpfs tmpfs rw",
    ].join("\n");
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo,
      resolveRealPath: (p) => p,
    });
    expect(result).not.toBeNull();
    expect(result!.fsType).toBe("tmpfs");
    expect(result!.mountPoint).toBe("/home/user/.openclaw");
  });

  it("does not flag tmpfs /tmp when state dir is on ext4", () => {
    const mountInfo = [
      "22 1 0:21 / / rw - ext4 /dev/sda1 rw",
      "30 22 0:30 / /tmp rw - tmpfs tmpfs rw",
    ].join("\n");
    const result = detectLinuxVolatileStateDir("/home/user/.openclaw", {
      platform: "linux",
      mountInfo,
      resolveRealPath: (p) => p,
    });
    expect(result).toBeNull();
  });
});

describe("formatLinuxVolatileStateDirWarning", () => {
  it("formats warning with fsType and mount point", () => {
    const warning = formatLinuxVolatileStateDirWarning("~/.openclaw", {
      path: "/home/user/.openclaw",
      mountPoint: "/home/user/.openclaw",
      fsType: "tmpfs",
    });
    expect(warning).toContain("volatile filesystem");
    expect(warning).toContain("tmpfs");
    expect(warning).toContain("lost on reboot");
    expect(warning).toContain("OPENCLAW_STATE_DIR");
  });

  it("formats ramfs warning", () => {
    const warning = formatLinuxVolatileStateDirWarning("~/.openclaw", {
      path: "/home/user/.openclaw",
      mountPoint: "/home/user/.openclaw",
      fsType: "ramfs",
    });
    expect(warning).toContain("ramfs");
    expect(warning).toContain("volatile filesystem");
  });
});
