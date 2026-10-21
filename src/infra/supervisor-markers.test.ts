import { describe, expect, it } from "vitest";
import { detectGatewayRespawnSupervisor, detectRespawnSupervisor } from "./supervisor-markers.js";

const gatewayServiceEnv = {
  OPENCLAW_SERVICE_MARKER: " openclaw ",
  OPENCLAW_SERVICE_KIND: " gateway ",
};
const linuxOptIn = { includeLinuxOpenClawGatewayServiceMarker: true };
function expectSupervisor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  expected: ReturnType<typeof detectRespawnSupervisor>,
  options?: Parameters<typeof detectRespawnSupervisor>[2],
) {
  expect(detectRespawnSupervisor(env, platform, options)).toBe(expected);
}

describe("detectRespawnSupervisor", () => {
  it("detects launchd from OpenClaw's explicit marker or current gateway launchd job", () => {
    expectSupervisor({ OPENCLAW_LAUNCHD_LABEL: " ai.openclaw.gateway " }, "darwin", "launchd");
    expectSupervisor({ OPENCLAW_LAUNCHD_LABEL: "   " }, "darwin", null);
    expectSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, "darwin", "launchd");
    expectSupervisor(
      { LAUNCH_JOB_NAME: "ai.openclaw.work", OPENCLAW_PROFILE: "work" },
      "darwin",
      "launchd",
    );
    expectSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.mac" }, "darwin", null);
    expectSupervisor({ XPC_SERVICE_NAME: "ai.openclaw.mac" }, "darwin", null);
    expectSupervisor(
      { XPC_SERVICE_NAME: "ai.openclaw.mac", OPENCLAW_PROFILE: "mac" },
      "darwin",
      null,
    );
    expectSupervisor({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }, "darwin", "launchd");
  });

  it("detects Linux OpenClaw gateway service markers only for opt-in callers", () => {
    expectSupervisor(gatewayServiceEnv, "linux", null);
    expectSupervisor(gatewayServiceEnv, "linux", "systemd", linuxOptIn);
    expectSupervisor(
      { ...gatewayServiceEnv, OPENCLAW_SERVICE_KIND: "worker" },
      "linux",
      null,
      linuxOptIn,
    );
    expectSupervisor(
      { ...gatewayServiceEnv, OPENCLAW_SERVICE_MARKER: "other" },
      "linux",
      null,
      linuxOptIn,
    );
  });

  it("detects scheduled-task supervision on Windows from either hint family", () => {
    expectSupervisor({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" }, "win32", "schtasks");
    expectSupervisor(gatewayServiceEnv, "win32", "schtasks");
    expectSupervisor({ ...gatewayServiceEnv, OPENCLAW_SERVICE_KIND: "worker" }, "win32", null);
    expectSupervisor({ ...gatewayServiceEnv, OPENCLAW_SERVICE_MARKER: "other" }, "win32", null);
  });

  it("ignores service markers on non-Windows platforms and unknown platforms", () => {
    expectSupervisor(gatewayServiceEnv, "linux", null);
    expectSupervisor({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, "freebsd", null);
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
