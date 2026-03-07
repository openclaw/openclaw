import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it("surfaces headless systemd recovery hints on linux", () => {
    const hints = buildGatewayRuntimeHints(
      {
        detail:
          "systemctl --user unavailable: Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
      },
      {
        platform: "linux",
        env: { USER: "ubuntu" },
      },
    );

    expect(hints).toEqual(
      expect.arrayContaining([
        "Run: sudo loginctl enable-linger ubuntu",
        "Export: XDG_RUNTIME_DIR=/run/user/$(id -u)",
        "Verify: systemctl --user status",
      ]),
    );
  });
});
