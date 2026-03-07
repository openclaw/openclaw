import { formatCliCommand } from "../cli/command-format.js";

export function isSystemdUnavailableDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemctl not available") ||
    normalized.includes("not been booted with systemd") ||
    normalized.includes("failed to connect to bus") ||
    normalized.includes("systemd user services are required")
  );
}

function isMissingUserBusRuntimeDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("no medium found") ||
    normalized.includes("failed to connect to user scope bus via local transport") ||
    normalized.includes("$dbus_session_bus_address") ||
    normalized.includes("$xdg_runtime_dir not defined") ||
    normalized.includes("xdg_runtime_dir not defined")
  );
}

function resolveSystemdUserHint(env?: NodeJS.ProcessEnv): string {
  const user = env?.USER?.trim() || env?.LOGNAME?.trim();
  return user || "$(whoami)";
}

export function renderSystemdUnavailableHints(
  options: {
    wsl?: boolean;
    detail?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  if (options.wsl) {
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  if (isMissingUserBusRuntimeDetail(options.detail)) {
    return [
      "systemd user services are unavailable in this shell because the user D-Bus/session runtime is missing.",
      `Run: sudo loginctl enable-linger ${resolveSystemdUserHint(options.env)}`,
      "Export: XDG_RUNTIME_DIR=/run/user/$(id -u)",
      "Verify: systemctl --user status",
      `Then retry: ${formatCliCommand("openclaw gateway install", options.env ?? process.env)}`,
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway", options.env ?? process.env)}\`.`,
  ];
}
