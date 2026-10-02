import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForGatewayHealthyRestart } from "../cli/daemon-cli/restart-health.js";
import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { mockDoctorServicePlatform } from "./doctor-maintenance.state-owner.test-support.js";

const native = vi.hoisted(() => ({
  directory: "",
  resident: vi.fn<() => { pid: number } | undefined>(),
  busctl: vi.fn<typeof import("../daemon/systemd-exec.js").execBusctlSystem>(),
  systemctl: vi.fn<typeof import("../daemon/systemd-exec.js").execSystemctl>(),
  open: vi.fn<typeof import("../daemon/systemd-peer-native.js").openSystemdBroker>(),
}));
// The manager identity fixture runs Doctor outside its synthetic Gateway's service.
vi.mock("../daemon/service-process-membership.js", () => ({
  inspectServiceProcessMembershipSync: () => "outside",
}));
vi.mock("../gateway/call.js", async (original) => {
  const { gatewayMaintenanceResponse } = await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../gateway/call.js")>()),
    callGatewayCli: gatewayMaintenanceResponse(() => native.resident()),
  };
});
vi.mock("../daemon/systemd-exec.js", async (original) => {
  const { gatewayMaintenanceSystemdShow } =
    await import("../gateway/health-response.test-support.js");
  return {
    ...(await original<typeof import("../daemon/systemd-exec.js")>()),
    execBusctlSystem: native.busctl,
    execSystemctl: native.systemctl,
    execSystemctlUser: gatewayMaintenanceSystemdShow,
  };
});
vi.mock("../daemon/systemd-peer-native.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-peer-native.js")>()),
  openSystemdBroker: native.open,
}));
vi.mock("../infra/container-environment.js", () => ({ isContainerEnvironment: () => false }));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => native.directory,
}));
vi.mock("../cli/daemon-cli/restart-health.js", async (original) => ({
  ...(await original<typeof import("../cli/daemon-cli/restart-health.js")>()),
  inspectGatewayRestart: vi.fn(async () => ({ healthy: true })),
  waitForGatewayHealthyRestart: vi.fn(async () => ({ healthy: true })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unitName = "openclaw-gateway.service";
const unitFile = `/etc/systemd/system/${unitName}`;
const unitObject = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
type Scenario =
  | "unchanged"
  | "account-refused"
  | "account-reassigned-at-activation"
  | "manager-replaced"
  | "broker-replaced"
  | "capture-unavailable"
  | "inspection-failed";

beforeEach(() => {
  vi.clearAllMocks();
  native.resident.mockReset();
  mockDoctorServicePlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(os, "homedir").mockImplementation(() => native.directory);
  vi.spyOn(os, "userInfo").mockImplementation(() => ({
    username: "root",
    uid: 0,
    gid: 0,
    homedir: native.directory,
    shell: "/bin/sh",
  }));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function repair(scenario: Scenario) {
  const home = tempDirs.make("openclaw-doctor-native-");
  native.directory = home;
  const port = await getFreePort();
  const fixtureUnit = path.join(home, unitName);
  await fsp.writeFile(fixtureUnit, "[Service]\nUser=root\n");
  const access = fsp.access;
  const readFile = fsp.readFile;
  // Scope discovery and the native command reader see one synthetic system unit.
  vi.spyOn(fsp, "access").mockImplementation((file, mode) =>
    access(file === unitFile ? fixtureUnit : file, mode),
  );
  vi.spyOn(fsp, "readFile").mockImplementation((file, options) =>
    readFile(file === unitFile ? fixtureUnit : file, options),
  );
  let running = true;
  // The synthetic Gateway must not be this test process or one of its ancestors.
  const ancestors = getSelfAndAncestorPidsSync();
  let pid = 12345;
  while (ancestors.has(pid)) {
    pid += 1;
  }
  native.resident.mockImplementation(() => (running ? { pid } : undefined));
  let stopped = false;
  let diagnosticFailure = false;
  let serviceUser = "root";
  let managerOwner = ":1.42";
  let busId = "0123456789abcdef0123456789abcdef";
  const effects: string[] = [];
  const logs: string[] = [];
  const reply = (args: string[]): Array<{ type: string; data: unknown }> => {
    const method = args[4];
    if (args[0] === "call") {
      if (!method) {
        throw new Error("Missing native method in fixture query");
      }
      if (method === "GetId") {
        return [{ type: "s", data: [busId] }];
      }
      if (method === "GetNameOwner") {
        return [{ type: "s", data: [managerOwner] }];
      }
      if (method === "GetConnectionUnixUser") {
        return [{ type: "u", data: [0] }];
      }
      if (method === "GetUnit" || method === "LoadUnit") {
        return [{ type: "o", data: [unitObject] }];
      }
      if (["ResetFailedUnit", "StartUnit", "RestartUnit"].includes(method)) {
        expect(args[1]).toBe(":1.42");
        effects.push(method);
        if (method === "ResetFailedUnit") {
          return [];
        }
        running = true;
        return [{ type: "o", data: ["/org/freedesktop/systemd1/job/7"] }];
      }
    }
    if (args[0] === "get-property") {
      const command = [
        process.execPath,
        path.join(process.cwd(), "openclaw.mjs"),
        "gateway",
        "--port",
        String(port),
      ];
      const properties: Record<string, { type: string; data: unknown }> = {
        Id: { type: "s", data: unitName },
        FragmentPath: { type: "s", data: unitFile },
        DropInPaths: { type: "as", data: [] },
        NeedDaemonReload: { type: "b", data: false },
        LoadState: { type: "s", data: "loaded" },
        ActiveState: { type: "s", data: running ? "active" : "inactive" },
        SubState: { type: "s", data: running ? "running" : "dead" },
        StartLimitBurst: { type: "u", data: 5 },
        ActiveEnterTimestampMonotonic: { type: "t", data: 100 },
        InactiveEnterTimestampMonotonic: { type: "t", data: 200 },
        Result: { type: "s", data: "success" },
        NRestarts: { type: "u", data: 0 },
        MainPID: { type: "u", data: running ? pid : 0 },
        ExecMainStatus: { type: "i", data: 0 },
        ExecMainCode: { type: "i", data: 1 },
        KillMode: { type: "s", data: "control-group" },
        TasksCurrent: { type: "t", data: running ? 1 : 0 },
        MemoryCurrent: { type: "t", data: 0 },
        ControlGroup: { type: "s", data: "/system.slice/openclaw-gateway.service" },
        ExecStart: {
          type: "a(sasbttttuii)",
          data: [[command[0], command, false, 0, 0, 0, 0, 0, 0, 0]],
        },
        WorkingDirectory: { type: "s", data: "" },
        Environment: { type: "as", data: [`HOME=${home}`] },
        EnvironmentFiles: { type: "a(sb)", data: [] },
        UnsetEnvironment: { type: "as", data: [] },
        User: { type: "s", data: serviceUser },
      };
      return args.slice(4).map((name) => {
        const property = properties[name];
        if (!property) {
          throw new Error(`Unexpected native property: ${name}`);
        }
        return property;
      });
    }
    throw new Error(`Unexpected native query: ${args.join(" ")}`);
  };
  native.busctl.mockImplementation(async (rawArgs) => {
    const args = rawArgs.filter((arg) => !arg.startsWith("--"));
    if (stopped && diagnosticFailure) {
      diagnosticFailure = false;
      return { code: 1, termination: "exit", stdout: "", stderr: "Failed to connect to bus" };
    }
    return {
      code: 0,
      termination: "exit",
      stdout: reply(args)
        .map((property) => JSON.stringify(property))
        .join("\n"),
      stderr: "",
    };
  });
  native.systemctl.mockImplementation(async (args) => {
    const action = args[0];
    if (!action) {
      throw new Error("Missing systemctl action in fixture query");
    }
    if (action === "stop") {
      effects.push("stop");
      stopped = true;
      running = false;
    } else if (action !== "is-enabled") {
      // A missing pinned identity must fail visibly if it reaches unbound activation.
      effects.push(action);
      running = true;
    }
    return { code: 0, termination: "exit", stdout: "enabled", stderr: "" };
  });
  native.open.mockImplementation(async () => {
    if (scenario === "capture-unavailable") {
      throw new Error("native identity probe unavailable");
    }
    if (stopped && scenario === "account-reassigned-at-activation") {
      serviceUser = "other-account";
    }
    return {
      verify() {},
      close: async () => {},
      query: async (args, signatures, _deadline, assertCurrent) => {
        assertCurrent?.();
        const values = reply(args);
        expect(values.map((value) => value.type)).toEqual(signatures);
        return values.map((value) => value.data);
      },
    };
  });
  return await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
      DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/synthetic-doctor-native/bus",
    },
    async () => {
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true, json: true },
        runtime: { log: (...args) => logs.push(args.join(" ")), error() {}, exit() {} },
      });
      expect(effects).toEqual(scenario === "capture-unavailable" ? [] : ["stop"]);
      if (scenario === "account-refused") {
        serviceUser = "other-account";
      }
      if (scenario === "manager-replaced") {
        managerOwner = ":1.99";
      }
      if (scenario === "broker-replaced") {
        busId = "abcdef0123456789abcdef0123456789";
      }
      diagnosticFailure = scenario === "inspection-failed";
      let error: unknown;
      try {
        await maintenance?.finish({});
      } catch (caught) {
        error = caught;
      } finally {
        await maintenance?.release();
      }
      return { effects, logs, error, running };
    },
  );
}

it.each([
  { scenario: "account-refused", reason: "systemd-account-refused" },
  { scenario: "account-reassigned-at-activation", reason: "systemd-account-refused" },
  { scenario: "manager-replaced", reason: "systemd-manager-changed" },
  { scenario: "broker-replaced", reason: "systemd-manager-changed" },
] as const)(
  "Doctor preserves native $scenario after stopping its Gateway",
  async ({ scenario, reason }) => {
    const result = await repair(scenario);
    expect(result.effects).toEqual(["stop"]);
    expect(result.running).toBe(false);
    expect(result.error).toMatchObject({
      message: expect.stringContaining(
        reason === "systemd-account-refused"
          ? "runs as another account"
          : "manager identity changed",
      ),
      failureFacts: expect.arrayContaining([expect.objectContaining({ code: reason })]),
    });
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
    expect(result.logs.join("\n")).not.toContain("restoration inspection was inconclusive");
  },
);

it.each([
  { scenario: "unchanged", action: "RestartUnit" },
  { scenario: "inspection-failed", action: "StartUnit" },
] as const)(
  "Doctor restores and verifies native ownership after $scenario",
  async ({ scenario, action }) => {
    const result = await repair(scenario);
    expect(result.error).toBeUndefined();
    expect(result.effects).toEqual(["stop", "ResetFailedUnit", action]);
    expect(result.running).toBe(true);
    expect(waitForGatewayHealthyRestart).toHaveBeenCalledOnce();
    expect(result.logs).toContain("Gateway restarted and verified after Doctor repair.");
    if (scenario === "inspection-failed") {
      expect(result.logs.join("\n")).toContain("restoration inspection was inconclusive");
    }
  },
);

it("leaves the Gateway running and warns when restoration identity cannot be captured", async () => {
  const result = await repair("capture-unavailable");
  expect(result.error).toBeUndefined();
  expect(result.effects).toEqual([]);
  expect(result.running).toBe(true);
  expect(result.logs.join("\n")).toContain("managed service was not stopped");
  expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
});
