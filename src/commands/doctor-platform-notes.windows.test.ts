import { describe, expect, it, vi } from "vitest";

const serviceIsLoaded = vi.fn(async () => false);
const serviceReadRuntime = vi.fn(async () => ({ status: "stopped" as const }));
const collectWindowsGatewayStatus = vi.fn(
  async (
    _env: NodeJS.ProcessEnv,
    _params?: {
      execFileImpl?: unknown;
      taskRegistered?: boolean;
      startupEntryInstalled?: boolean;
      runtimeStatus?: string;
      portListening?: boolean;
    },
  ) => ({
    serviceMode: "startup-fallback" as const,
    taskName: "OpenClaw Gateway",
    taskRegistered: false,
    startupEntryInstalled: true,
    taskScriptPath: "C:\\Users\\user\\.openclaw\\gateway\\OpenClaw Gateway.cmd",
    registrationPath:
      "C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd",
    registrationDetail:
      "Startup-folder login item is installed at C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\OpenClaw Gateway.cmd.",
    logDir: "C:\\Users\\user\\.openclaw\\logs\\gateway",
    stdoutPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.out.log",
    stderrPath: "C:\\Users\\user\\.openclaw\\logs\\gateway\\gateway.err.log",
    degradedReason: "Windows is using the Startup-folder fallback instead of a Scheduled Task.",
    recommendedAction:
      "Re-run from an elevated PowerShell session if you want Scheduled Task supervision.",
    wsl: {
      wslExeAvailable: true,
      defaultDistroName: "Ubuntu-24.04",
      defaultDistroReachable: true,
      systemdEnabled: false,
      recommendedAction:
        "Enable systemd in `/etc/wsl.conf`, run `wsl --shutdown`, then reopen your distro.",
    },
  }),
);

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: serviceIsLoaded,
    readRuntime: serviceReadRuntime,
  }),
}));

vi.mock("../daemon/windows-status.js", () => ({
  collectWindowsGatewayStatus: (
    env: NodeJS.ProcessEnv,
    params?: {
      execFileImpl?: unknown;
      taskRegistered?: boolean;
      startupEntryInstalled?: boolean;
      runtimeStatus?: string;
      portListening?: boolean;
    },
  ) => collectWindowsGatewayStatus(env, params),
}));

const { noteWindowsGatewayPlatformNotes } = await import("./doctor-platform-notes.js");

describe("noteWindowsGatewayPlatformNotes", () => {
  it("prints actionable Windows startup, log, and WSL guidance", async () => {
    const noteFn = vi.fn();

    await noteWindowsGatewayPlatformNotes({ platform: "win32", noteFn });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const [message, title] = noteFn.mock.calls[0] ?? [];
    expect(title).toBe("Gateway (Windows)");
    expect(message).toContain("Windows startup mode: startup-fallback");
    expect(message).toContain("Registration: Startup-folder login item is installed");
    expect(message).toContain("Gateway logs:");
    expect(message).toContain("Gateway issue: Windows is using the Startup-folder fallback");
    expect(message).toContain("Recommended action: Re-run from an elevated PowerShell session");
    expect(message).toContain("WSL2 is installed, but systemd is disabled");
    expect(message).toContain("WSL2 fix: Enable systemd in `/etc/wsl.conf`");
  });

  it("does nothing outside Windows", async () => {
    const noteFn = vi.fn();

    await noteWindowsGatewayPlatformNotes({ platform: "linux", noteFn });

    expect(noteFn).not.toHaveBeenCalled();
  });
});
