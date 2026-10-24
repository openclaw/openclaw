import { describe, expect, it } from "vitest";
import { buildGatewayRuntimeHints } from "./doctor-format.js";

describe("buildGatewayRuntimeHints", () => {
  it.each([
    [
      "win32",
      { status: "stopped", state: "Disabled" },
      [
        "Scheduled Task 'OpenClaw Gateway (work)' is registered but DISABLED",
        "openclaw --profile work gateway start",
        "openclaw --profile work doctor --fix",
        "to re-enable it",
      ],
    ],
    [
      "darwin",
      { status: "unknown", missingGuiSession: true },
      ["logged-in macOS GUI session", "openclaw --profile work gateway restart"],
    ],
  ] as const)("renders %s recovery for the selected profile", (platform, runtime, expected) => {
    const hints = buildGatewayRuntimeHints(runtime, {
      platform,
      env: { OPENCLAW_PROFILE: "work" },
    });
    expect(hints).toEqual(
      expect.arrayContaining(expected.map((text) => expect.stringContaining(text))),
    );
    if (platform === "win32") {
      expect(hints.join("\n")).not.toContain("likely exited immediately");
    }
  });

  it.each(["user", "system"] as const)("inspects the %s systemd cgroup", (scope) => {
    const systemd = {
      scope,
      unit: "openclaw-gateway.service",
      killMode: "process",
      tasksCurrent: 807,
      memoryCurrent: 11_918_534_246,
    };
    expect(
      buildGatewayRuntimeHints(
        { status: "running", pid: 1234, systemd },
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

  it.each([
    {
      name: "stopped system service journal",
      runtime: { status: "stopped", systemd: { scope: "system", unit: "openclaw.service" } },
      env: {},
      expected: ["Logs: journalctl --system -u openclaw.service -n 200 --no-pager"],
      excluded: "journalctl --user",
    },
    {
      name: "WSL recovery using the provided env",
      runtime: {
        status: "unknown",
        detail: "System has not been booted with systemd as init system",
      },
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      expected: [
        "WSL2 needs systemd enabled: edit /etc/wsl.conf with [boot]\\nsystemd=true",
        "Then run: wsl --shutdown (from PowerShell) and reopen your distro.",
        "Verify: systemctl --user status",
      ],
      excluded: "systemd user services are unavailable",
    },
    {
      name: "structured systemd inspection failure",
      runtime: {
        status: "unknown",
        detail: "service runtime inspection failed; retry with openclaw status --deep",
        inspectionFailure: {
          code: "service-runtime-inspection-failed",
          detail: "systemctl --user unavailable: Failed to connect to bus",
        },
      },
      env: {},
      expected: [expect.stringContaining("systemd user services are unavailable")],
    },
    {
      name: "systemd crash-loop start limit",
      runtime: {
        status: "stopped",
        state: "failed",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      },
      env: {},
      expected: [
        expect.stringContaining("systemd stopped restarting the gateway after repeated crashes"),
        expect.stringContaining("openclaw gateway restart"),
      ],
      excluded: "likely exited immediately",
    },
  ] as const)("renders $name", ({ runtime, env, expected, ...rest }) => {
    const hints = buildGatewayRuntimeHints(runtime, { platform: "linux", env });
    expect(hints).toEqual(expect.arrayContaining([...expected]));
    if ("excluded" in rest) {
      expect(hints.join("\n")).not.toContain(rest.excluded);
    }
  });
});
