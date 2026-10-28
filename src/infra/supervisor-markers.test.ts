import { expect, it } from "vitest";
import { detectGatewayRespawnSupervisor, detectRespawnSupervisor } from "./supervisor-markers.js";

const service = { OPENCLAW_SERVICE_MARKER: " openclaw ", OPENCLAW_SERVICE_KIND: " gateway " };
const worker = { ...service, OPENCLAW_SERVICE_KIND: "worker" };
const foreign = { ...service, OPENCLAW_SERVICE_MARKER: "other" };
const macApp = { XPC_SERVICE_NAME: "ai.openclaw.mac" };
type Case = [
  NodeJS.Platform,
  NodeJS.ProcessEnv,
  ReturnType<typeof detectRespawnSupervisor>,
  boolean?,
];

it.each<Case>([
  ["darwin", { OPENCLAW_LAUNCHD_LABEL: " ai.openclaw.gateway " }, "launchd"],
  ["darwin", { OPENCLAW_LAUNCHD_LABEL: "   " }, null],
  ["darwin", { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, "launchd"],
  ["darwin", { XPC_SERVICE_NAME: "ai.openclaw.gateway" }, "launchd"],
  ["darwin", { LAUNCH_JOB_NAME: "ai.openclaw.work", OPENCLAW_PROFILE: "work" }, "launchd"],
  ["darwin", { LAUNCH_JOB_LABEL: "ai.openclaw.mac" }, null],
  ["darwin", macApp, null],
  ["linux", service, null],
  ["linux", service, "systemd", true],
  ["linux", worker, null, true],
  ["linux", foreign, null, true],
  ["win32", { OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" }, "schtasks"],
  ["win32", service, "schtasks"],
  ["win32", worker, null],
  ["win32", foreign, null],
  ["freebsd", { LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, null],
])("detects %s supervisor from %j", (platform, env, expected, optIn = false) => {
  expect(
    detectRespawnSupervisor(env, platform, {
      includeLinuxOpenClawGatewayServiceMarker: optIn,
    }),
  ).toBe(expected);
});

it("keeps external ownership separate from native supervisor detection", () => {
  const env = {
    OPENCLAW_SUPERVISOR_MODE: "external",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
  };

  expect(detectGatewayRespawnSupervisor(env, "darwin")).toBe("external");
  expect(detectRespawnSupervisor(env, "darwin")).toBe("launchd");
});
