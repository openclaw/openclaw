import { describe, expect, it } from "vitest";
import { renderGatewayServiceCleanupHints } from "./inspect.js";

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      sourcePath: "/Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      sourcePath: "/Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "sudo launchctl bootout system/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchAgents/com.example.openclaw-gateway.plist",
      sourcePath: "/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "inspects the detected user-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      sourcePath: "/home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- custom-gateway.service",
      secondHint: "systemctl --user cat -- custom-gateway.service",
    },
    {
      title: "inspects the detected system-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      sourcePath: "/etc/systemd/system/custom-gateway.service",
      scope: "system",
      firstHint: "systemctl --system status -- custom-gateway.service",
      secondHint: "systemctl --system cat -- custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      sourcePath: "/home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- -custom-gateway.service",
      secondHint: "systemctl --user cat -- -custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      sourcePath: "/Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      secondHint: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)(
    "$title",
    ({ platform, serviceName, source, sourcePath, scope, firstHint, secondHint }) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform,
            label: serviceName,
            detail: source,
            sourcePath,
            scope,
          },
        ]),
      ).toEqual([firstHint, secondHint]);
    },
  );

  it("inspects the detected Windows scheduled task without suggesting removal", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\OpenClaw Gateway Backup",
          detail: "task: \\OpenClaw Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Query /TN "\\OpenClaw Gateway Backup" /V /FO LIST']);
  });

  it.each(["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.openclaw-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.openclaw-gateway"]);
  });
});
