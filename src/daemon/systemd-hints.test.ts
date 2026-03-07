import { describe, expect, it } from "vitest";
import { isSystemdUnavailableDetail, renderSystemdUnavailableHints } from "./systemd-hints.js";

describe("isSystemdUnavailableDetail", () => {
  it("matches headless user-bus failures", () => {
    expect(
      isSystemdUnavailableDetail(
        "systemctl --user unavailable: Failed to connect to bus: No medium found",
      ),
    ).toBe(true);
  });
});

describe("renderSystemdUnavailableHints", () => {
  it("renders headless recovery steps when the user bus runtime is missing", () => {
    const hints = renderSystemdUnavailableHints({
      detail:
        "systemctl --user unavailable: Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      env: { USER: "ec2-user", OPENCLAW_PROFILE: "isolated" },
    });

    expect(hints).toEqual(
      expect.arrayContaining([
        "systemd user services are unavailable in this shell because the user D-Bus/session runtime is missing.",
        "Run: sudo loginctl enable-linger ec2-user",
        "Export: XDG_RUNTIME_DIR=/run/user/$(id -u)",
        "Verify: systemctl --user status",
      ]),
    );
    expect(hints.some((hint) => hint.includes("gateway install"))).toBe(true);
  });

  it("falls back to the generic container hint when no headless detail is present", () => {
    const hints = renderSystemdUnavailableHints();

    expect(hints[0]).toBe(
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
    );
    expect(hints[1]).toContain("openclaw gateway");
  });

  it("prefers WSL instructions when running under WSL", () => {
    const hints = renderSystemdUnavailableHints({
      wsl: true,
      detail: "Failed to connect to bus: No medium found",
    });

    expect(hints).toEqual([
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
      "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
      "Verify: systemctl --user status",
    ]);
  });
});
