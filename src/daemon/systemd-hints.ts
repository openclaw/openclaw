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
    normalized.includes("no medium found") ||
    normalized.includes("systemd user services are required")
  );
}

/**
 * Returns diagnostic details about why systemd user services may be unavailable.
 * Useful for headless/SSH environments where XDG_RUNTIME_DIR or linger is missing.
 */
export function diagnoseSystemdEnvironment(): string[] {
  const diagnostics: string[] = [];
  if (!process.env.XDG_RUNTIME_DIR) {
    diagnostics.push(
      "XDG_RUNTIME_DIR is not set. This is required for systemd user services.",
      `  Fix: export XDG_RUNTIME_DIR=/run/user/$(id -u)`,
    );
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
    diagnostics.push(
      "DBUS_SESSION_BUS_ADDRESS is not set. The D-Bus session bus is needed for systemctl --user.",
    );
  }
  return diagnostics;
}

export function renderSystemdUnavailableHints(options: { wsl?: boolean } = {}): string[] {
  if (options.wsl) {
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  const envDiagnostics = diagnoseSystemdEnvironment();
  return [
    "systemd user services are unavailable.",
    ...(envDiagnostics.length > 0 ? ["", "Diagnostics:", ...envDiagnostics] : []),
    "",
    "On headless servers (EC2, VPS, etc.), run:",
    "  sudo loginctl enable-linger $(whoami)",
    '  export XDG_RUNTIME_DIR=/run/user/$(id -u)  # add to ~/.bashrc for persistence',
    "",
    `Then retry: ${formatCliCommand("openclaw gateway install --force")}`,
    "",
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    "Alternatively, run the gateway under your own process supervisor (systemd system-level, supervisord, etc.).",
  ];
}
