import { expect, it } from "vitest";
import { renderGatewayServiceCleanupHints, type ExtraGatewayService } from "./inspect.js";

type HintCase = [name: string, services: ExtraGatewayService[], expected: string[]];
const agentLabel = "com.example.openclaw-gateway";
const agent: ExtraGatewayService = {
  platform: "darwin",
  label: agentLabel,
  detail: "loaded",
  scope: "user",
};
const daemonPath = `/Library/LaunchDaemons/${agentLabel}.plist`;
const globalAgentPath = `/Library/LaunchAgents/${agentLabel}.plist`;
const quotedPath = "/Users/test/Launch Agents/example's gateway.plist";
const task = (label: string): ExtraGatewayService => ({
  platform: "win32",
  label,
  detail: `task: ${label}`,
  scope: "system",
});

it.each<HintCase>([
  ["no extra service", [], []],
  [
    "system LaunchDaemon",
    [{ ...agent, scope: "system", sourcePath: daemonPath, detail: `plist: ${daemonPath}` }],
    [
      "sudo launchctl bootout system/com.example.openclaw-gateway",
      "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    ],
  ],
  [
    "global LaunchAgent in GUI domain",
    [
      {
        ...agent,
        scope: "system",
        sourcePath: globalAgentPath,
        detail: `plist: ${globalAgentPath}`,
      },
    ],
    [
      "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    ],
  ],
  [
    "system systemd unit",
    [
      {
        platform: "linux",
        label: "custom-gateway.service",
        scope: "system",
        detail: "unit: /etc/systemd/system/custom-gateway.service",
        sourcePath: "/etc/systemd/system/custom-gateway.service",
      },
    ],
    [
      "systemctl --system status -- custom-gateway.service",
      "systemctl --system cat -- custom-gateway.service",
    ],
  ],
  [
    "user systemd unit beginning with a dash",
    [
      {
        platform: "linux",
        label: "-custom-gateway.service",
        scope: "user",
        detail: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
        sourcePath: "/home/test/.config/systemd/user/-custom-gateway.service",
      },
    ],
    [
      "systemctl --user status -- -custom-gateway.service",
      "systemctl --user cat -- -custom-gateway.service",
    ],
  ],
  [
    "shell-quoted POSIX label and path",
    [
      {
        ...agent,
        label: "com.example.gateway; touch injected",
        sourcePath: quotedPath,
        detail: `plist: ${quotedPath}`,
      },
    ],
    [
      "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    ],
  ],
  [
    "Windows task inspection without removal",
    [task("\\OpenClaw Gateway Backup")],
    ['schtasks /Query /TN "\\OpenClaw Gateway Backup" /V /FO LIST'],
  ],
  ...["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"].map(
    (label): HintCase => [`rejects expandable Windows label ${label}`, [task(label)], []],
  ),
  ["missing source path", [agent], ["launchctl bootout gui/$UID/com.example.openclaw-gateway"]],
])("renders cleanup hints for %s", (_name, services, expected) => {
  expect(renderGatewayServiceCleanupHints(services)).toEqual(expected);
});
