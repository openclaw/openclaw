import { describe, expect, it } from "vitest";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

describe("buildPlatformRuntimeLogHints", () => {
  it("renders launchd log hints on darwin", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
          OPENCLAW_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /tmp/openclaw-state/logs/gateway.log",
      "Launchd stderr (if installed): /tmp/openclaw-state/logs/gateway.err.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual(["Logs: journalctl --user -u openclaw-gateway.service -n 200 --no-pager"]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        env: {
          USERPROFILE: "C:\\Users\\test",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "Gateway stdout: C:\\Users\\test\\.openclaw\\logs\\gateway.log",
      "Gateway stderr: C:\\Users\\test\\.openclaw\\logs\\gateway.err.log",
      'Task details: schtasks /Query /TN "OpenClaw Gateway" /V /FO LIST',
    ]);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installCommand: "openclaw gateway install",
        startCommand: "openclaw gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "openclaw gateway install",
      "openclaw gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.openclaw.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installCommand: "openclaw gateway install",
        startCommand: "openclaw gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "openclaw gateway install",
      "openclaw gateway",
      "systemctl --user start openclaw-gateway.service",
    ]);
  });
});
