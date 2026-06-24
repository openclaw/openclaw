// Doctor format tests cover doctor output formatting and issue display helpers.
import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it("prioritizes macOS GUI-session failures over generic missing supervision", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        missingSupervision: true,
        missingGuiSession: true,
      },
      { platform: "darwin", env: {} },
    );

    expect(hints.join("\n")).toContain("logged-in macOS GUI session");
    expect(hints.join("\n")).not.toContain("LaunchAgent installed but not loaded");
  });

  it("surfaces suspicious systemd cgroup hygiene with inspection commands", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "process",
            tasksCurrent: 807,
            memoryCurrent: 11_918_534_246,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([
      "Systemd cgroup hygiene looks elevated: cgroup hygiene: KillMode=process, tasks=807, memory=11.1GiB.",
      "This usually means old helper or browser processes may still be attached to the gateway service.",
      "Run: systemctl --user show openclaw-gateway.service -p KillMode -p TasksCurrent -p MemoryCurrent -p MainPID",
      "Run: systemd-cgls --user-unit openclaw-gateway.service",
      "After reviewing service settings, run: openclaw gateway restart",
    ]);
  });

  it("uses the provided env when rendering WSL systemd recovery hints", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        detail: "System has not been booted with systemd as init system",
      },
      { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } },
    );

    expect(hints).toContain(
      "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
    );
    expect(hints).toContain("Then run: wsl --shutdown (from PowerShell) and reopen your distro.");
    expect(hints).toContain("Verify: systemctl --user status");
    expect(hints.join("\n")).not.toContain("systemd user services are unavailable");
  });

  it("does not warn for normal systemd cgroup metrics", () => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            unit: "openclaw-gateway.service",
            killMode: "control-group",
            tasksCurrent: 7,
            memoryCurrent: 132_120_576,
          },
        },
        { platform: "linux", env: {} },
      ),
    ).toEqual([]);
  });
});
