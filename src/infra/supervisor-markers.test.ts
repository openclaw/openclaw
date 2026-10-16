import { describe, expect, it } from "vitest";
import { detectGatewayRespawnSupervisor, detectRespawnSupervisor } from "./supervisor-markers.js";

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
    expect(
      detectRespawnSupervisor(
        {
          OPENCLAW_SERVICE_MARKER: "other",
          OPENCLAW_SERVICE_KIND: "gateway",
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

describe("detectGatewayRespawnSupervisor", () => {
  it("keeps external ownership separate from native supervisor detection", () => {
    const env = {
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
    };

    expect(detectGatewayRespawnSupervisor(env, "darwin")).toBe("external");
    expect(detectRespawnSupervisor(env, "darwin")).toBe("launchd");
  });
});
