import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { isSystemdUnavailableDetail, renderSystemdUnavailableHints } from "./systemd-hints.js";

describe("isSystemdUnavailableDetail", () => {
  it("matches systemd unavailable error details", () => {
    expect(
      isSystemdUnavailableDetail("systemctl --user unavailable: Failed to connect to bus"),
    ).toBe(true);
    expect(
      isSystemdUnavailableDetail(
        "systemctl not available; systemd user services are required on Linux.",
      ),
    ).toBe(true);
    expect(isSystemdUnavailableDetail("permission denied")).toBe(false);
  });
});

describe("renderSystemdUnavailableHints", () => {
  it("renders WSL2-specific recovery hints", () => {
    expect(renderSystemdUnavailableHints({ wsl: true })).toEqual([
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ]);
  });

  it("renders generic Linux recovery hints outside WSL", () => {
    expect(renderSystemdUnavailableHints()).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      `If you're in a container, run the gateway in the foreground instead of \`${formatCliCommand("openclaw gateway")}\`.`,
    ]);
  });
});
