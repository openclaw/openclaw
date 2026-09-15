import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLaunchDaemonPlistLabel } from "./launchd-system.js";

vi.mock("./exec-file.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./exec-file.js")>();
  return {
    ...original,
    execFileUtf8: (...args: Parameters<typeof original.execFileUtf8>) =>
      args[1].at(-1) === "-"
        ? original.execFileUtf8(...args)
        : Promise.resolve({ stdout: "", stderr: "simulated parser denial", code: 1 }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform !== "darwin")("native LaunchDaemon snapshot parsing", () => {
  it.each([false, true])("reads real bytes through plutil stdin (binary=%s)", async (binary) => {
    const target = path.join(tempDirs.make("launchd-native-"), "foreign-name.plist");
    writeFileSync(
      target,
      '<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>',
    );
    if (binary) {
      execFileSync("/usr/bin/plutil", ["-convert", "binary1", "--", target]);
    }
    expect(await readLaunchDaemonPlistLabel(target)).toEqual({
      status: "ok",
      label: "ai.openclaw.gateway",
    });
  });

  it.skipIf(process.getuid?.() === 0)("classifies actual read denial", async () => {
    const target = path.join(tempDirs.make("launchd-native-"), "denied.plist");
    writeFileSync(target, "unreadable", { mode: 0o000 });
    try {
      expect(await readLaunchDaemonPlistLabel(target)).toEqual({ status: "unreadable" });
    } finally {
      chmodSync(target, 0o600);
    }
  });

  it("refuses real malformed and oversized snapshots", async () => {
    const target = path.join(tempDirs.make("launchd-native-"), "invalid.plist");
    for (const contents of ["not a plist", "x".repeat(1048577)]) {
      writeFileSync(target, contents);
      expect(await readLaunchDaemonPlistLabel(target)).toMatchObject({ status: "unverifiable" });
    }
  });
});
