// Doctor format tests cover doctor output formatting and issue display helpers.
import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it("names the disabled Scheduled Task and recovery for the selected profile", () => {
    const text = buildGatewayRuntimeHints(
      { status: "stopped", state: "Disabled" },
      { platform: "win32", env: { OPENCLAW_PROFILE: "work" } },
    ).join("\n");

    expect(text).toContain("Scheduled Task 'OpenClaw Gateway (work)' is registered but DISABLED");
    expect(text).toContain("openclaw --profile work gateway start");
    expect(text).toContain("openclaw --profile work doctor --fix");
    expect(text).toContain("to re-enable it");
    expect(text).not.toContain("likely exited immediately");
  });

  it("renders macOS GUI-session recovery for the selected profile", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        missingGuiSession: true,
      },
      { platform: "darwin", env: { OPENCLAW_PROFILE: "work" } },
    );

    expect(hints.join("\n")).toContain("logged-in macOS GUI session");
    expect(hints.join("\n")).toContain("openclaw --profile work gateway restart");
  });

  it.each(["user", "system"] as const)("inspects the %s systemd cgroup", (scope) => {
    expect(
      buildGatewayRuntimeHints(
        {
          status: "running",
          pid: 1234,
          systemd: {
            scope,
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
      `Run: systemctl --${scope} show openclaw-gateway.service -p KillMode -p TasksCurrent -p MemoryCurrent -p MainPID`,
      `Run: systemd-cgls ${scope === "system" ? "--unit" : "--user-unit"} openclaw-gateway.service`,
      "After reviewing service settings, run: openclaw gateway restart",
    ]);
  });

  it("points stopped system services to their actual journal", () => {
    const hints = buildGatewayRuntimeHints(
      { status: "stopped", systemd: { scope: "system", unit: "openclaw.service" } },
      { platform: "linux", env: {} },
    );
    expect(hints).toContain("Logs: journalctl --system -u openclaw.service -n 200 --no-pager");
    expect(hints.join("\n")).not.toContain("journalctl --user");
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

  it("classifies systemd recovery from structured inspection diagnostics", () => {
    const hints = buildGatewayRuntimeHints(
      {
        status: "unknown",
        detail: "service runtime inspection failed; retry with openclaw status --deep",
        inspectionFailure: {
          code: "service-runtime-inspection-failed",
          detail: "systemctl --user unavailable: Failed to connect to bus",
        },
      },
      { platform: "linux", env: {} },
    );

    expect(hints.some((hint) => hint.includes("systemd user services are unavailable"))).toBe(true);
  });

  it("guides recovery when systemd hit its restart start limit (crash loop)", () => {
    // Real give-up shape: process kept failing (Result=exit-code) until NRestarts
    // reached StartLimitBurst and systemd stopped restarting.
    const text = buildGatewayRuntimeHints(
      {
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      },
      { platform: "linux", env: {} },
    ).join("\n");

    expect(text).toContain("systemd stopped restarting the gateway after repeated crashes");
    expect(text).toContain("openclaw gateway restart");
    expect(text).not.toContain("likely exited immediately");
  });
});
