import { formatCliCommand } from "../cli/command-format.js";
import { resolveDaemonContainerContext } from "./container-context.js";
import {
  classifySystemdUnavailableDetail,
  type SystemdUnavailableKind,
} from "./systemd-unavailable.js";

type SystemdUnavailableHintOptions = {
  wsl?: boolean;
  kind?: SystemdUnavailableKind | null;
  env?: Record<string, string | undefined>;
};

export function isSystemdUnavailableDetail(detail?: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

export function renderSystemdUnavailableHints(
  options: SystemdUnavailableHintOptions = {},
): string[] {
  if (options.wsl) {
    // WSL requires systemd opt-in at distro boot, not just a package install.
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    ...(resolveDaemonContainerContext(options.env) || options.kind !== "user_bus_unavailable"
      ? []
      : [
          "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
          "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry.",
        ]),
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway", options.env)}\`.`,
  ];
}
