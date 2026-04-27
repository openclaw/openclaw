import { formatCliCommand } from "../cli/command-format.js";
import { classifySystemdUnavailableDetail, } from "./systemd-unavailable.js";
export function isSystemdUnavailableDetail(detail) {
    return classifySystemdUnavailableDetail(detail) !== null;
}
function renderSystemdHeadlessServerHints() {
    return [
        "On a headless server (SSH/no desktop session): run `sudo loginctl enable-linger $(whoami)` to persist your systemd user session across logins.",
        "Also ensure XDG_RUNTIME_DIR is set: `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then retry.",
    ];
}
export function renderSystemdUnavailableHints(options = {}) {
    if (options.wsl) {
        return [
            "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
            "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
            "Verify: systemctl --user status",
        ];
    }
    return [
        "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
        ...(options.container || options.kind !== "user_bus_unavailable"
            ? []
            : renderSystemdHeadlessServerHints()),
        `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ];
}
