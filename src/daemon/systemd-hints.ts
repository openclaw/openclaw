import { formatCliCommand } from "../cli/command-format.js";
import {
  classifySystemdUnavailableDetail,
  type SystemdUnavailableKind,
} from "./systemd-unavailable.js";

type SystemdUnavailableHintOptions = {
  wsl?: boolean;
  kind?: SystemdUnavailableKind | null;
  container?: boolean;
  /**
   * When true, the status pipeline already observed healthy OpenClaw units
   * on the *system* bus (e.g. on headless hosts). In that case the "user
   * bus unavailable" message is misleading — runtime is fine — so we skip
   * the generic "systemd user services are unavailable" guidance.
   */
  systemServicesDetected?: boolean;
};

export function isSystemdUnavailableDetail(detail?: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

function renderSystemdHeadlessServerHints(): string[] {
  return [
    "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
    "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry.",
  ];
}

export function renderSystemdUnavailableHints(
  options: SystemdUnavailableHintOptions = {},
): string[] {
  if (options.systemServicesDetected) {
    // Runtime is fine via system-level systemd units; don't tell the user
    // the user bus is "required".
    return [];
  }
  if (options.wsl) {
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd, run the gateway under system-level systemd, or run it under your own supervisor.",
    ...(options.container || options.kind !== "user_bus_unavailable"
      ? []
      : renderSystemdHeadlessServerHints()),
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
  ];
}
