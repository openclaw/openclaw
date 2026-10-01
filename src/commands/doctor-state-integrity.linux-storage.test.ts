import { describe, expect, it } from "vitest";
import {
  detectLinuxSdBackedStateDir,
  formatLinuxSdBackedStateDirWarning,
} from "./doctor-state-integrity.js";

describe("Linux state storage", () => {
  it("selects the deepest mount using the resolved state path", () => {
    expect(
      detectLinuxSdBackedStateDir("/tmp/openclaw-state", {
        platform: "linux",
        mountInfo: [
          "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
          "30 24 179:5 / /mnt/slow rw,relatime - ext4 /dev/mmcblk1p1 rw",
          "25 24 0:22 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
        ].join("\n"),
        resolveRealPath: () => "/mnt/slow/openclaw/.openclaw",
      }),
    ).toEqual({
      path: "/mnt/slow/openclaw/.openclaw",
      mountPoint: "/mnt/slow",
      fsType: "ext4",
      source: "/dev/mmcblk1p1",
    });
  });

  it("returns null outside Linux", () => {
    expect(
      detectLinuxSdBackedStateDir("/Users/tester/.openclaw", {
        platform: "darwin",
        mountInfo: "24 19 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw",
      }),
    ).toBeNull();
  });

  it("resolves device aliases and escapes decoded mountinfo control characters in warnings", () => {
    const stateDir = "/home/pi/mnt\nspoofed/.openclaw";
    const result = detectLinuxSdBackedStateDir(stateDir, {
      platform: "linux",
      mountInfo:
        "30 24 179:2 / /home/pi/mnt\\012spoofed rw,relatime - ext4 /dev/disk/by-uuid/mmc\\012source rw",
      resolveRealPath: () => stateDir,
      resolveDeviceRealPath: (device) =>
        device === "/dev/disk/by-uuid/mmc\nsource" ? "/dev/mmcblk0p2" : null,
    });
    if (!result) {
      throw new Error("Expected Linux state storage warning details");
    }
    const warning = formatLinuxSdBackedStateDirWarning(stateDir, result);
    expect(warning).toContain("device /dev/disk/by-uuid/mmc\\nsource");
    expect(warning).toContain("mount /home/pi/mnt\\nspoofed");
    expect(warning).not.toContain("device /dev/disk/by-uuid/mmc\nsource");
    expect(warning).not.toContain("mount /home/pi/mnt\nspoofed");
  });
});
