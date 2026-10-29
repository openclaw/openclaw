import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import { ServiceInspectionError } from "./service-inspection-error.js";
import { readGatewayServiceState, resolveGatewayService, type GatewayService } from "./service.js";
import { createMockGatewayService, mockSystemAccountHome } from "./service.test-helpers.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";

const serviceEnv = (scenario: string) => ({
  HOME: `/openclaw-service-proof/${scenario}`,
  XDG_RUNTIME_DIR: `/openclaw-service-proof/${scenario}/runtime`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/openclaw-service-proof/${scenario}/bus`,
  USER: "service",
  LOGNAME: "service",
  SUDO_USER: undefined,
});
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
function missingFiles(accessible?: string, readable?: string) {
  mockProcessPlatform("linux");
  vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
    if (file !== readable) {
      throw missing();
    }
    return "[Service]\nExecStart=/usr/bin/node /old/openclaw/dist/index.js gateway\n";
  });
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if (file !== accessible) {
      throw missing();
    }
  });
  vi.spyOn(fs, "readdir").mockResolvedValue([]);
}
const execSpy = async () => vi.spyOn(await import("./exec-file.js"), "execFileUtf8");
const nativeResult = (stdout = "", stderr = ""): ExecResult =>
  nativeExit(stdout, stderr, stderr ? 1 : 0);
const strictRead = { requireEffective: true, requireLoadedCommand: true };
const unavailable = "service-manager-unavailable";
async function missingUserBus(stdout: string) {
  (await execSpy()).mockImplementation(async (command) =>
    command === "busctl"
      ? nativeResult("", "Failed to connect to bus: No such file or directory")
      : nativeResult(stdout),
  );
}

beforeEach(mockSystemAccountHome);
afterEach(() => vi.restoreAllMocks());

it.each([
  { scope: "user", manager: "missing-tools" },
  { scope: "system", manager: "missing-tools" },
  { scope: "system", manager: "not-booted" },
])("reports a stale $scope unit with $manager", async ({ scope, manager }) => {
  const env = serviceEnv(`${scope}-${manager}`);
  const unitPath =
    scope === "user"
      ? `${env.HOME}/.config/systemd/user/openclaw-gateway.service`
      : "/etc/systemd/system/openclaw-gateway.service";
  missingFiles(unitPath, unitPath);
  (await execSpy()).mockImplementation(async () => ({
    ...nativeResult(
      "",
      "System has not been booted with systemd as init system (PID 1). Can't operate.",
    ),
    termination: manager === "missing-tools" ? "error" : "exit",
    errorCode: manager === "missing-tools" ? "ENOENT" : undefined,
  }));
  const state = await readGatewayServiceState(resolveGatewayService(), { env });
  expect(state).toMatchObject({
    systemdInstallation: { kind: scope },
    installed: true,
    inspectionReason: unavailable,
    runtime: { inspectionReason: unavailable },
  });
});

it("retains proven manager absence without a recorded unit", async () => {
  mockProcessPlatform("linux");
  vi.spyOn(fs, "lstat").mockRejectedValue(missing());
  vi.spyOn(fs, "access").mockRejectedValue(missing());
  vi.spyOn(fs, "readdir").mockResolvedValue([]);
  const native = await execSpy();
  const state = await readGatewayServiceState(resolveGatewayService(), {
    env: { ...serviceEnv("no-manager-or-unit"), DBUS_SESSION_BUS_ADDRESS: undefined },
  });
  expect(state).toMatchObject({
    inspectionReason: unavailable,
    installed: false,
    command: null,
    runtime: { inspectionReason: unavailable, missingUnit: true },
  });
  expect(native).not.toHaveBeenCalled();
});

it("retains command diagnosis after runtime failure", async () => {
  vi.spyOn(await import("./systemd-exec.js"), "assertSystemdAvailable").mockRejectedValue(
    new Error("systemctl not available"),
  );
  const state = await readSystemdServiceRuntime(serviceEnv("runtime-failure"), {
    systemdReadTarget: {
      scope: "user",
      unitName: "openclaw-gateway.service",
      unitPath: "/openclaw-service-proof/runtime-failure/gateway.service",
    },
    commandInspection: {
      kind: "unavailable",
      error: new ServiceInspectionError(unavailable),
    },
  });
  expect(state).toMatchObject({ status: "unknown", inspectionReason: unavailable });
});

it.each([true, false])("missing user bus with running system unit=%s", async (running) => {
  missingFiles(running ? "/etc/systemd/system/openclaw-gateway.service" : undefined);
  await missingUserBus(
    running
      ? "LoadState=loaded\nActiveState=active\nMainPID=42\n"
      : "LoadState=not-found\nActiveState=inactive\nSubState=dead\n",
  );
  const state = await readGatewayServiceState(resolveGatewayService(), {
    env: serviceEnv("missing-user-bus"),
  });
  expect(state).toMatchObject(
    running
      ? { runtime: { status: "running", pid: 42 } }
      : { inspectionReason: "systemd-user-bus-unavailable", runtime: { status: "unknown" } },
  );
  if (running) {
    expect(state.inspectionReason).toBeUndefined();
  } else {
    expect(state.runtime?.missingUnit).not.toBe(true);
  }
});

it.each(["revoked", "expired"])("absent projection: %s", async (condition) => {
  let current = true;
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const binding = {
    unit: "openclaw-gateway.service",
    managerUid: 1000,
    destination: ":1.0",
    verify: vi.fn(() => {
      if (!current) {
        throw new Error("original binding retired");
      }
    }),
    query: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
  const isAbsent = vi.fn<NonNullable<GatewayService["isAbsent"]>>(async (args) => {
    if (!args.strictCommandAbsent) {
      return false;
    }
    current = condition !== "revoked";
    now += condition === "expired" ? 1001 : 0;
    return true;
  });
  const service = createMockGatewayService({ isAbsent });
  const observed = readGatewayServiceState(service, {
    env: { HOME: "/openclaw-service-proof" },
    ...strictRead,
    systemdReadBinding: binding,
    timeoutMs: 1000,
  });
  await expect(observed).rejects.toThrow(
    condition === "revoked" ? "original binding retired" : "deadline expired",
  );
  expect(service.readCommand).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ systemdReadBinding: binding }),
  );
  expect(service.readRuntime).not.toHaveBeenCalled();
  expect(binding.close).not.toHaveBeenCalled();
});

it.each(["absent", "system-loaded", "system-unavailable"])(
  "strict absence: %s",
  async (condition) => {
    missingFiles();
    vi.spyOn(fs, "lstat").mockRejectedValue(missing());
    const run = await execSpy();
    run.mockImplementation(async (command, args) => {
      const system = args.includes("--system");
      const success = (type: string, data: unknown) => nativeResult(JSON.stringify({ type, data }));
      const failure = (stderr: string) => nativeResult("", stderr);
      if (system && condition === "system-unavailable") {
        return failure("Failed to connect to bus: No such file or directory");
      }
      if (args.includes("Version")) {
        expect(command).toBe("busctl");
        expect(args).toEqual(
          (
            "--user --auto-start=no get-property org.freedesktop.systemd1 " +
            "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version"
          ).split(" "),
        );
        return nativeResult('s "252.39"');
      }
      if (args.includes("GetNameOwner")) {
        return success("s", [":1.2"]);
      }
      if (args.includes("GetUnit")) {
        return system && condition === "system-loaded"
          ? success("o", ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"])
          : failure("Call failed: Unit openclaw-gateway.service not loaded.");
      }
      if (args.includes("GetUnitFileState")) {
        return failure("Call failed: No such file or directory");
      }
      if (system && args.includes("UnitPath")) {
        return success("as", ["/etc/systemd/system"]);
      }
      return failure("Unexpected native query");
    });
    const result = readGatewayServiceState(resolveGatewayService(), {
      env: serviceEnv(condition),
      ...strictRead,
    });
    if (condition === "absent") {
      await expect(result).resolves.toMatchObject({
        installed: false,
        command: null,
        loadState: { status: "not-loaded" },
        runtime: { status: "stopped", missingUnit: true },
        running: false,
      });
    } else {
      expect((await result).runtime?.missingUnit).not.toBe(true);
    }
    expect(run.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
  },
);
