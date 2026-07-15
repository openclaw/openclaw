// Covers supervisor marker files used to identify managed OpenClaw processes.
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { detectRespawnSupervisor, SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

describe("SUPERVISOR_HINT_ENV_VARS", () => {
  it("includes the cross-platform supervisor hint env vars", () => {
    const envVars = new Set(SUPERVISOR_HINT_ENV_VARS);
    expect(envVars.has("LAUNCH_JOB_LABEL")).toBe(true);
    expect(envVars.has("INVOCATION_ID")).toBe(true);
    expect(envVars.has("OPENCLAW_WINDOWS_TASK_NAME")).toBe(true);
    expect(envVars.has("OPENCLAW_SERVICE_MARKER")).toBe(true);
    expect(envVars.has("OPENCLAW_SERVICE_KIND")).toBe(true);
  });
});

describe("detectRespawnSupervisor", () => {
  it("detects launchd from OpenClaw's explicit marker or current gateway launchd job", () => {
    expect(
      detectRespawnSupervisor({ OPENCLAW_LAUNCHD_LABEL: " ai.openclaw.gateway " }, "darwin"),
    ).toBe("launchd");
    expect(detectRespawnSupervisor({ OPENCLAW_LAUNCHD_LABEL: "   " }, "darwin")).toBeNull();
    expect(detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, "darwin")).toBe(
      "launchd",
    );
    expect(
      detectRespawnSupervisor(
        { LAUNCH_JOB_NAME: "ai.openclaw.work", OPENCLAW_PROFILE: "work" },
        "darwin",
      ),
    ).toBe("launchd");
    expect(detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.mac" }, "darwin")).toBeNull();
    expect(detectRespawnSupervisor({ XPC_SERVICE_NAME: "ai.openclaw.mac" }, "darwin")).toBeNull();
    expect(
      detectRespawnSupervisor(
        { XPC_SERVICE_NAME: "ai.openclaw.mac", OPENCLAW_PROFILE: "mac" },
        "darwin",
      ),
    ).toBeNull();
    expect(detectRespawnSupervisor({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }, "darwin")).toBe(
      "launchd",
    );
  });

  it("detects systemd only from non-blank platform-specific hints", () => {
    expect(detectRespawnSupervisor({ INVOCATION_ID: "abc123" }, "linux")).toBe("systemd");
    expect(detectRespawnSupervisor({ JOURNAL_STREAM: "" }, "linux")).toBeNull();
  });

  it("detects Linux OpenClaw gateway service markers only for opt-in callers", () => {
    const gatewayServiceEnv = {
      OPENCLAW_SERVICE_MARKER: " openclaw ",
      OPENCLAW_SERVICE_KIND: " gateway ",
    };
    expect(detectRespawnSupervisor(gatewayServiceEnv, "linux")).toBeNull();
    expect(
      detectRespawnSupervisor(gatewayServiceEnv, "linux", {
        includeLinuxOpenClawGatewayServiceMarker: true,
      }),
    ).toBe("systemd");
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "worker",
        },
        "linux",
        { includeLinuxOpenClawGatewayServiceMarker: true },
      ),
    ).toBeNull();
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "other",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
        "linux",
        { includeLinuxOpenClawGatewayServiceMarker: true },
      ),
    ).toBeNull();
  });

  it("detects scheduled-task supervision on Windows from either hint family", () => {
    expect(
      detectRespawnSupervisor({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" }, "win32"),
    ).toBe("schtasks");
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
        "win32",
      ),
    ).toBe("schtasks");
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "worker",
        },
        "win32",
      ),
    ).toBeNull();
  });

  it("ignores service markers on non-Windows platforms and unknown platforms", () => {
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
        "linux",
      ),
    ).toBeNull();
    expect(
      detectRespawnSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, "freebsd"),
    ).toBeNull();
  });
});

describe("win32 schtasks probe fallback", () => {
  const mockSpawnSync = vi.mocked(spawnSync);

  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("returns schtasks when probe succeeds with no env vars set", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: null,
    });
    expect(detectRespawnSupervisor({}, "win32")).toBe("schtasks");
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "schtasks.exe",
      ["/Query", "/TN", "OpenClaw Gateway"],
      expect.objectContaining({ timeout: 3000, stdio: "pipe", windowsHide: true }),
    );
  });

  it("returns null when probe fails (task not found)", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: null,
    });
    expect(detectRespawnSupervisor({}, "win32")).toBeNull();
  });

  it("returns null when probe throws (schtasks.exe not found)", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(detectRespawnSupervisor({}, "win32")).toBeNull();
  });

  it("skips probe when env vars are already set", () => {
    expect(
      detectRespawnSupervisor({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" }, "win32"),
    ).toBe("schtasks");
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("skips probe when markers are present but don't match", () => {
    expect(
      detectRespawnSupervisor(
        { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "worker" },
        "win32",
      ),
    ).toBeNull();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it("returns null when probe status is null (process killed by signal)", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
    });
    expect(detectRespawnSupervisor({}, "win32")).toBeNull();
  });

  it("returns null when probe throws on timeout", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("ETIMEDOUT");
    });
    expect(detectRespawnSupervisor({}, "win32")).toBeNull();
  });

  it("probes when env has unrelated keys but no known markers", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: null,
    });
    expect(detectRespawnSupervisor({ PATH: "/usr/bin", HOME: "/home/user" }, "win32")).toBe(
      "schtasks",
    );
    expect(mockSpawnSync).toHaveBeenCalled();
  });

  it("probes when marker is whitespace-only after trim", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: null,
    });
    expect(detectRespawnSupervisor({ OPENCLAW_SERVICE_MARKER: "   " }, "win32")).toBe("schtasks");
    expect(mockSpawnSync).toHaveBeenCalled();
  });

  it("probes when marker is set but service kind is missing (incomplete signal)", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "",
      signal: null,
    });
    expect(detectRespawnSupervisor({ OPENCLAW_SERVICE_MARKER: "openclaw" }, "win32")).toBe(
      "schtasks",
    );
    expect(mockSpawnSync).toHaveBeenCalled();
  });
});
