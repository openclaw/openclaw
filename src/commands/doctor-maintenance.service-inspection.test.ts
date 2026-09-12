import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { printDaemonStatus } from "../cli/daemon-cli/status.print.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { execFileUtf8 } from "../daemon/exec-file.js";
import { inspectSystemLaunchDaemonOwnership } from "../daemon/launchd-system.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { openSystemdPrivatePeer } from "../daemon/systemd-peer-native.js";
import { defaultRuntime } from "../runtime.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

// These diagnostics model unavailable transports, not the runner's real user manager.
vi.mock("../daemon/systemd-peer-native.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-peer-native.js")>()),
  openSystemdBroker: vi
    .fn()
    .mockRejectedValue(new Error("Synthetic user-manager broker unavailable")),
  openSystemdPrivatePeer: vi
    .fn()
    .mockRejectedValue(new Error("Unexpected private-peer opening in unavailable-broker fixture")),
}));
vi.mock("../daemon/exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  {
    platform: "linux",
    reason: "systemd-user-bus-unavailable",
    message: "systemd user session bus is unavailable",
    hint: "dbus-user-session",
  },
  {
    platform: "linux",
    reason: "service-manager-access-denied",
    message: "service-manager probe could not start (EACCES/EPERM)",
    hint: "executable permissions",
  },
  {
    platform: "darwin",
    reason: "launchd-system-domain-unavailable",
    message: "launchd system domain cannot be queried by this account",
    hint: "root",
  },
  {
    platform: "darwin",
    reason: "launchd-gui-domain-unavailable",
    message: "launchd GUI domain is unavailable for this account",
    hint: "logged-in macOS desktop session",
  },
  {
    platform: "darwin",
    reason: "launchd-system-owned",
    message: "Gateway label belongs to a system LaunchDaemon",
    hint: "deployment owner",
  },
] as const)("preserves $reason from native probe through repair and status", async (scenario) => {
  const home = tempDirs.make("openclaw-service-inspection-");
  mockProcessPlatform(scenario.platform);
  mockSystemAccountHome();
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_PROFILE",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_SERVICE_REPAIR_POLICY",
    "OPENCLAW_SERVICE_MARKER",
    "OPENCLAW_SERVICE_KIND",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SUDO_USER",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("USER", "svc");
  if (scenario.platform === "linux") {
    const unitDir = path.join(home, ".config/systemd/user");
    await fs.mkdir(unitDir, { recursive: true });
    await fs.writeFile(
      path.join(unitDir, "openclaw-gateway.service"),
      "[Service]\nExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs gateway\n",
    );
  }
  vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
    if (scenario.reason === "service-manager-access-denied") {
      return {
        code: 1,
        termination: "error",
        errorCode: "EACCES",
        stdout: "",
        stderr: "Command failed during launch or output capture (EACCES)",
      };
    }
    if (command === "busctl") {
      return {
        code: 1,
        termination: "exit",
        stdout: "",
        stderr:
          "Failed to connect to user scope bus via local transport: No such file or directory",
      };
    }
    if (command === "systemctl") {
      return {
        code: 0,
        termination: "exit",
        stdout: args.includes("show") ? "ActiveState=active\nMainPID=1234" : "enabled",
        stderr: "",
      };
    }
    if (command === "launchctl") {
      const system = args[1]?.startsWith("system/");
      if (system && scenario.reason === "launchd-system-owned") {
        return { code: 0, termination: "exit", stdout: "state = running\npid = 1234", stderr: "" };
      }
      if (system && scenario.reason === "launchd-gui-domain-unavailable") {
        return { code: 113, termination: "exit", stdout: "", stderr: "Could not find service" };
      }
      return {
        code: 125,
        termination: "exit",
        stdout: "",
        stderr: "Could not print domain: 125: Domain does not support specified action",
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const service = resolveGatewayService();
  await expect
    .soft(service.readCommand(process.env, { requireEffective: true }))
    .rejects.toMatchObject({
      reason: scenario.reason,
    });
  if (scenario.reason === "launchd-system-domain-unavailable") {
    await expect
      .soft(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway"))
      .resolves.toMatchObject({
        status: "unverifiable",
        reason: scenario.reason,
      });
  }
  const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
    root: home,
    updateInstallKind: "package",
    shouldRestart: true,
    jsonMode: true,
    phase: "inspect",
  });
  expect(inspection).toMatchObject({
    inspected: false,
    stopped: false,
    serviceMutationAllowed: false,
  });
  expect.soft(inspection.blockMessage).toContain(scenario.message);
  const maintenance = beginDoctorMaintenance({
    root: home,
    options: { repair: true },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  await expect.soft(maintenance).rejects.toThrow(scenario.message);

  const state = await readGatewayServiceState(service, { env: process.env });
  expect.soft(state).toMatchObject({ inspectionReason: scenario.reason });
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  printDaemonStatus(
    {
      service: {
        ...state,
        label: service.label,
        loaded: null,
        loadedText: "loaded",
        notLoadedText: "not loaded",
      },
      extraServices: [],
    },
    { json: false, deep: true },
  );
  const output = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
  expect.soft(output.split(scenario.message)).toHaveLength(2);
  expect.soft(output).toContain(scenario.hint);
  expect.soft(output).not.toContain("systemctl not available");
  expect.soft(output).not.toContain("Service unit not found.");
  for (const hint of [
    "OPENCLAW_SERVICE_REPAIR_POLICY=external",
    "skips native maintenance inspection and service mutations",
    "Gateway/state coordinators and agent-database lease checks",
    "https://docs.openclaw.ai/gateway#existing-system-launchdaemons",
  ]) {
    await expect.soft(maintenance).rejects.toThrow(hint);
    expect.soft(output).toContain(hint);
  }
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
});
