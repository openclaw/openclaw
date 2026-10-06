import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as boundaryPath from "../infra/boundary-path.js";
import {
  detectLinuxSdBackedStateDir,
  formatLinuxSdBackedStateDirWarning,
} from "./doctor-state-integrity.js";

afterEach(() => vi.restoreAllMocks());

describe("Linux state storage", () => {
  it("selects the deepest mount using the resolved state path", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      [
        "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
        "30 24 179:5 / /mnt/slow rw,relatime - ext4 /dev/mmcblk1p1 rw",
        "25 24 0:22 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
      ].join("\n"),
    );
    vi.spyOn(boundaryPath, "safeRealpathSync").mockReturnValue("/mnt/slow/openclaw/.openclaw");
    expect(detectLinuxSdBackedStateDir("/tmp/openclaw-state")).toEqual({
      path: "/mnt/slow/openclaw/.openclaw",
      mountPoint: "/mnt/slow",
      fsType: "ext4",
      source: "/dev/mmcblk1p1",
    });
  });

  it("returns null outside Linux", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(detectLinuxSdBackedStateDir("/Users/tester/.openclaw")).toBeNull();
  });

  it("resolves device aliases and escapes decoded mountinfo control characters in warnings", () => {
    const stateDir = "/home/pi/mnt\nspoofed/.openclaw";
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "30 24 179:2 / /home/pi/mnt\\012spoofed rw,relatime - ext4 /dev/disk/by-uuid/mmc\\012source rw",
    );
    vi.spyOn(boundaryPath, "safeRealpathSync").mockImplementation((target) =>
      target === "/dev/disk/by-uuid/mmc\nsource" ? "/dev/mmcblk0p2" : stateDir,
    );
    const result = detectLinuxSdBackedStateDir(stateDir);
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
