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

export function renderSystemdUnavailableHints(options: {
  wsl?: boolean;
  missingEnvVars?: string[];
} = {}): string[] {
  if (options.missingEnvVars?.length) {
    const hints: string[] = [
      `Missing environment variables for systemd --user: ${options.missingEnvVars.join(", ")}`,
    ];
    const missingXdg = options.missingEnvVars.includes("XDG_RUNTIME_DIR");
    const missingDbus = options.missingEnvVars.includes("DBUS_SESSION_BUS_ADDRESS");
    if (missingXdg || missingDbus) {
      hints.push("On headless servers, enable lingering to create a user session at boot:");
      hints.push("  loginctl enable-linger $USER");
      hints.push("Then log out and back in, or reboot.");
      hints.push("");
      hints.push("Alternatively, set the variables manually:");
      if (missingXdg) {
        hints.push("  export XDG_RUNTIME_DIR=/run/user/$(id -u)");
      }
      if (missingDbus) {
        hints.push("  export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus");
      }
    }
    return hints;
  }
  if (options.wsl) {
    return [
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ];
  }
  return [
    "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
  ];
}
