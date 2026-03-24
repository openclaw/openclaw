import { describe, expect, it } from "vitest";
import {
  parseScQcOutput,
  parseScQueryExOutput,
  parseWindowsServiceRegistryParameters,
  probeWindowsService,
  resolveWindowsServiceName,
} from "./windows-service.js";

describe("windows-service", () => {
  it("parses service config output", () => {
    const parsed = parseScQcOutput(`
SERVICE_NAME: OpenClawGateway
        TYPE               : 10  WIN32_OWN_PROCESS
        BINARY_PATH_NAME   : C:\\tools\\nssm.exe
        DISPLAY_NAME       : OpenClaw Gateway
        SERVICE_START_NAME : LocalSystem
`);
    expect(parsed.binaryPathName).toBe("C:\\tools\\nssm.exe");
    expect(parsed.displayName).toBe("OpenClaw Gateway");
    expect(parsed.serviceStartName).toBe("LocalSystem");
  });

  it("parses service runtime output", () => {
    const parsed = parseScQueryExOutput(`
SERVICE_NAME: OpenClawGateway
        STATE              : 4  RUNNING
        WIN32_EXIT_CODE    : 0  (0x0)
        PID                : 162392
`);
    expect(parsed.state).toBe("4  RUNNING");
    expect(parsed.pid).toBe(162392);
    expect(parsed.win32ExitCode).toBe("0  (0x0)");
  });

  it("parses NSSM registry parameters", () => {
    const parsed = parseWindowsServiceRegistryParameters(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\OpenClawGateway\\Parameters
    Application    REG_EXPAND_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
    AppParameters    REG_EXPAND_SZ    -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\dammt\\.openclaw\\gateway-runner.ps1
    AppDirectory    REG_EXPAND_SZ    C:\\Users\\dammt\\.openclaw
`);
    expect(parsed.application).toContain("powershell.exe");
    expect(parsed.appParameters).toContain("gateway-runner.ps1");
    expect(parsed.appDirectory).toBe("C:\\Users\\dammt\\.openclaw");
  });

  it("resolves configured service names", () => {
    expect(resolveWindowsServiceName({})).toBe("OpenClawGateway");
    expect(resolveWindowsServiceName({ OPENCLAW_SERVICE_KIND: "node" })).toBe("OpenClawNode");
    expect(resolveWindowsServiceName({ OPENCLAW_PROFILE: "work" })).toBe("OpenClawGateway-work");
    expect(resolveWindowsServiceName({ OPENCLAW_WINDOWS_SERVICE_NAME: "CustomSvc" })).toBe(
      "CustomSvc",
    );
  });

  it("probes the configured service name", async () => {
    const probe = await probeWindowsService({
      OPENCLAW_WINDOWS_SERVICE_NAME: "DefinitelyMissingServiceName",
    });

    expect(probe).toBeNull();
  });
});
