import { describe, expect, it } from "vitest";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

describe("buildPlatformRuntimeLogHints", () => {
  it("renders launchd log hints on darwin", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          MULLUSI_STATE_DIR: "/tmp/mullusi-state",
          MULLUSI_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "mullusi-gateway",
        windowsTaskName: "Mullusi Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /tmp/mullusi-state/logs/gateway.log",
      "Launchd stderr (if installed): /tmp/mullusi-state/logs/gateway.err.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        systemdServiceName: "mullusi-gateway",
        windowsTaskName: "Mullusi Gateway",
      }),
    ).toEqual(["Logs: journalctl --user -u mullusi-gateway.service -n 200 --no-pager"]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        systemdServiceName: "mullusi-gateway",
        windowsTaskName: "Mullusi Gateway",
      }),
    ).toEqual(['Logs: schtasks /Query /TN "Mullusi Gateway" /V /FO LIST']);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installCommand: "mullusi gateway install",
        startCommand: "mullusi gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.mullusi.gateway.plist",
        systemdServiceName: "mullusi-gateway",
        windowsTaskName: "Mullusi Gateway",
      }),
    ).toEqual([
      "mullusi gateway install",
      "mullusi gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mullusi.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installCommand: "mullusi gateway install",
        startCommand: "mullusi gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.mullusi.gateway.plist",
        systemdServiceName: "mullusi-gateway",
        windowsTaskName: "Mullusi Gateway",
      }),
    ).toEqual([
      "mullusi gateway install",
      "mullusi gateway",
      "systemctl --user start mullusi-gateway.service",
    ]);
  });
});
