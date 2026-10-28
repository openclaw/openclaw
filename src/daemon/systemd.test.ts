import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { ExecResult } from "./exec-file.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import {
  buildSystemdManagerPropertyOutput as serviceProperties,
  buildSystemdUnitPropertyOutput as serializeSystemdUnitProperties,
  pathLikeToString,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import {
  captureOutput,
  environmentSnapshot,
  expectFiles,
  legacyGatewayUnit,
  writeUnit,
} from "./systemd-files.test-support.js";

type ExecFileMock = typeof import("./exec-file.js").execFileUtf8;
const execFileMock = vi.hoisted(() => vi.fn<ExecFileMock>());
const versionFixture = vi.hoisted(() => ({ useScenarioResponse: false }));
const existsSync = vi.hoisted(() => vi.fn<typeof import("node:fs").existsSync>(() => false));
const systemOwnership = vi.hoisted(() =>
  vi.fn<(unitName: string, timeoutMs?: number) => Promise<void>>(async () => {}),
);
const findSystemGatewayServicesMock = vi.hoisted(() =>
  vi.fn<typeof import("./inspect.js").findSystemGatewayServices>(async () => []),
);

vi.mock("./inspect.js", () => ({
  findSystemGatewayServices: () => findSystemGatewayServicesMock(),
}));

vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: (unitName: string, timeoutMs?: number) =>
    timeoutMs === undefined ? systemOwnership(unitName) : systemOwnership(unitName, timeoutMs),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync,
}));

// mock-isolation: Native manager commands must use fixture responses, never the host service manager.
vi.mock("./exec-file.js", async () => {
  const { createSystemdExecFixture } = await import("./systemd-exec.test-support.js");
  return {
    execFileUtf8: createSystemdExecFixture(execFileMock, versionFixture),
  };
});

import * as systemdExec from "./systemd-exec.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";
import { hasSudoToRootSystemdUserManagerMismatch } from "./systemd-user-transport.js";
import {
  findInstalledSystemdGatewayScope,
  findSystemdGatewayInstallation,
  formatDuelingScopesWarning,
  installSystemdService,
  isSystemdServiceEnabled,
  isSystemdUnitActive,
  isSystemdUserServiceAvailable,
  readSystemdServiceRuntime as readRuntime,
  readSystemdServiceExecStart as readServiceCommand,
  refreshLegacySystemdServiceMetadata as refreshMetadata,
  restartSystemdService,
  resolveSystemdUserServiceAccount,
  startSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallLegacySystemdUnits,
  uninstallSystemdService,
  isSystemUnitActiveAndEnabled,
  uninstallUserSystemdGatewayUnit,
} from "./systemd.js";

const access = fs.access.bind(fs);
const SERVICE_HOME = "/home/test";
const MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";
const NODE_SERVICE = "openclaw-node.service";
const serviceEnv = { HOME: SERVICE_HOME };
const strict = { requireEffective: true };
const gatewayArguments = ["/usr/bin/openclaw", "gateway", "run"];
const gatewayUnitPath = `${SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`;
const operatorDropIn = `${gatewayUnitPath}.d/operator.conf`;

function gatewayUnit(...directives: string[]) {
  return ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", ...directives];
}

function mockMissingBase() {
  return vi
    .spyOn(fs, "readFile")
    .mockRejectedValue(Object.assign(new Error("missing base"), { code: "ENOENT" }));
}

function mockUninstalledManager() {
  vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (env) => ({
    code: 1,
    termination: "exit",
    stdout: "",
    stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-gateway-work"}.service not found.`,
  }));
}

function readCommand(options?: Parameters<typeof readServiceCommand>[1]) {
  return readServiceCommand(serviceEnv, options);
}

type ServiceArgs = Parameters<typeof stageSystemdService>[0];
type ServiceOverrides = Omit<
  ServiceArgs,
  "env" | "stdout" | "programArguments" | "workingDirectory"
>;

function serviceArgs(
  env: ServiceArgs["env"],
  kind: "gateway" | "node",
  overrides: ServiceOverrides = {},
): ServiceArgs {
  return {
    env,
    stdout: captureOutput().stdout,
    programArguments: ["/usr/bin/openclaw", kind, "run"],
    workingDirectory: "/tmp",
    ...(kind === "node" ? { environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" } } : {}),
    ...overrides,
  };
}

async function fixture(kind: "gateway" | "node" | "user") {
  const home = tempDirs.make("openclaw-systemd-");
  const stateDir = path.join(home, ".openclaw");
  const env: Record<string, string> = { HOME: home };
  if (kind !== "user") {
    env.OPENCLAW_STATE_DIR = stateDir;
    env.OPENCLAW_SYSTEMD_UNIT = kind === "node" ? "openclaw-node" : "openclaw-gateway-stage-test";
  }
  if (kind === "node") {
    env.OPENCLAW_SERVICE_KIND = kind;
  }
  const unitPath = resolveSystemdUnitPath(env);
  if (kind === "user") {
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
  } else {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  }
  return {
    env,
    stateDir,
    unitPath,
    envFilePath: path.join(stateDir, "gateway.systemd.env"),
    nodeEnvFilePath: path.join(stateDir, "node.systemd.env"),
    stage: (overrides: ServiceOverrides) => {
      queueUserCommands(["status"]);
      return stageSystemdService(serviceArgs(env, kind === "node" ? kind : "gateway", overrides));
    },
    install: (overrides: ServiceOverrides = {}) =>
      installSystemdService(serviceArgs(env, kind === "node" ? kind : "gateway", overrides)),
  };
}

function requireFirstWrite(write: ReturnType<typeof vi.fn>): string {
  return String(expectDefined(write.mock.calls[0]?.[0], "expected systemd status write"));
}

function expectActions(...actions: string[]) {
  expect(execFileMock.mock.calls.map(([, args]) => args[1])).toEqual(actions);
}

function expectUserCommand(args: string[], ...command: string[]) {
  expect(args).toEqual(["--user", ...command]);
}

function expectMachineCommand(args: string[], user: string, ...command: string[]) {
  expect(args).toEqual(["--machine", `${user}@`, "--user", ...command]);
}

const userCommand = (...command: string[]): ExecFileMock => userResult(nativeExit(), ...command);

function machineCommand(user: string, ...command: string[]): ExecFileMock {
  return nativeResult(["--machine", `${user}@`, "--user", ...command]);
}

function userResult(output: ExecResult, ...command: string[]): ExecFileMock {
  return nativeResult(["--user", ...command], output);
}

function nativeResult(command: string[], output: ExecResult = nativeExit()): ExecFileMock {
  return async (_cmd, args) => {
    expect(args).toEqual(command);
    return output;
  };
}

function userFailure(detail: string, ...command: string[]): ExecFileMock {
  return userResult(failure(detail), ...command);
}

function queueUserCommands(...commands: string[][]) {
  for (const command of commands) {
    execFileMock.mockImplementationOnce(userCommand(...command));
  }
}

function failure(stderr: string, fields: Partial<Omit<ExecResult, "stderr">> = {}): ExecResult {
  return { ...nativeExit("", stderr, 1), ...fields };
}

function mockSystemMarker(name = "openclaw") {
  const sourcePath = `/etc/systemd/system/${name}.service`;
  findSystemGatewayServicesMock.mockResolvedValueOnce([
    {
      platform: "linux",
      label: `${name}.service`,
      detail: `unit: ${sourcePath}`,
      sourcePath,
      scope: "system",
      marker: "openclaw",
    },
  ]);
}

function mockNodeInstallNoMediumFailure(): void {
  queueUserCommands(["status"], ["daemon-reload"]);
  for (const action of ["enable", "disable"]) {
    execFileMock.mockImplementationOnce(
      userFailure("Failed to connect to bus: No medium found", action, NODE_SERVICE),
    );
  }
}

let machineFixtureId = 0;
function mockMachineManager(user: string): NodeJS.ProcessEnv {
  versionFixture.useScenarioResponse = true;
  const runtime = `/fixture/systemd-machine-${++machineFixtureId}`;
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(process.getuid?.() ?? 1000);
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
      return "mnt_id: 1\n";
    }
    if (args[0] === "/proc/self/mountinfo") {
      return "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
    }
    return await readFile(...args);
  });
  execFileMock.mockReset().mockImplementation(async (_command, args) => {
    if (args.includes("Version") && !args.includes("--machine")) {
      return failure("Failed to connect to bus: No medium found");
    }
    expect(args.slice(0, 3)).toEqual(["--machine", `${user}@`, "--user"]);
    return nativeExit(args.includes("Version") ? 's "252.39"' : "");
  });
  return {
    USER: user,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  };
}

function mockEffectiveUid(uid: number) {
  vi.spyOn(process, "geteuid").mockReturnValue(uid);
}

function mockUnit(unitLines: string[], extraFiles: Record<string, string | Error> = {}) {
  return vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    const pathValue = pathLikeToString(pathname);
    if (pathValue.endsWith(`/${GATEWAY_SERVICE}`)) {
      return unitLines.join("\n");
    }
    const extraFile = extraFiles[pathValue];
    if (typeof extraFile === "string") {
      return extraFile;
    }
    if (extraFile instanceof Error) {
      throw extraFile;
    }
    throw new Error(`unexpected readFile path: ${pathValue}`);
  });
}

function unitProperties(
  params: Pick<
    SystemdManagerSnapshotFixture,
    "fragmentPath" | "dropInPaths" | "needDaemonReload" | "loadState"
  >,
): string {
  return serializeSystemdUnitProperties({
    ...params,
    fragmentPath: params.fragmentPath ?? gatewayUnitPath,
  });
}

function mockProperties(
  output: string | Error,
  unitOutput: string | Error = unitProperties({}),
): void {
  vi.spyOn(systemdExec, "execBusctlUser").mockRestore();
  execFileMock.mockReset();
  execFileMock.mockImplementation(async (_command, args) => {
    const propertyOutput =
      args.includes("LoadUnit") || args.includes("GetUnit")
        ? JSON.stringify({
            type: "o",
            data: ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"],
          })
        : args.includes("org.freedesktop.systemd1.Unit")
          ? unitOutput
          : output;
    return propertyOutput instanceof Error
      ? failure(propertyOutput.message)
      : nativeExit(propertyOutput);
  });
}

function mockManager(overrides: Partial<SystemdManagerSnapshotFixture>): void {
  const snapshot = { programArguments: gatewayArguments, ...overrides };
  mockProperties(serviceProperties(snapshot), unitProperties(snapshot));
}

function mockNodeManager(unitPath: string, dropInPaths: string[] = [], inspect = () => {}) {
  mockManager({
    programArguments: ["/usr/bin/openclaw", "node", "run"],
    workingDirectory: "/tmp",
    environment: ["OPENCLAW_SYSTEMD_UNIT=openclaw-node"],
    fragmentPath: unitPath,
    dropInPaths,
  });
  const query = expectDefined(execFileMock.getMockImplementation(), "manager fixture");
  let activated = false;
  execFileMock.mockImplementation(async (command, args, options) => {
    if (command === "systemctl") {
      activated ||= args.includes("restart");
      return nativeExit(args.includes("is-enabled") ? "enabled\n" : "");
    }
    if (activated) {
      inspect();
    }
    return await query(command, args, options);
  });
}

const assertRestartSuccess = async (env: NodeJS.ProcessEnv) => {
  const { write, stdout } = captureOutput();
  await restartSystemdService({ stdout, env });
  expect(write).toHaveBeenCalledTimes(1);
  expect(requireFirstWrite(write)).toContain("Restarted systemd service");
};

let testFixtureId = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
  // Host-installed system units must not override the fixture's absent-service default.
  vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
    if (/^\/(?:etc|usr\/lib|lib)\/systemd\/system\//.test(pathLikeToString(pathname))) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return access(pathname, mode);
  });
  findSystemGatewayServicesMock.mockReset().mockResolvedValue([]);
  const runtime = `/fixture/systemd-test-${++testFixtureId}`;
  vi.stubEnv("XDG_RUNTIME_DIR", runtime);
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", `unix:path=${runtime}/bus`);
  versionFixture.useScenarioResponse = false;
  existsSync.mockReset();
  existsSync.mockReturnValue(false);
  systemOwnership.mockReset().mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("discovers the default private runtime directory from the effective UID", async () => {
  versionFixture.useScenarioResponse = true;
  mockEffectiveUid(1002);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const runtimeDir = "/run/user/1002";
  existsSync.mockImplementation((file) => file === `${runtimeDir}/systemd/private`);
  vi.spyOn(await import("./systemd-peer-native.js"), "openSystemdUserManager").mockResolvedValue({
    query: async (args) => {
      expect(args.at(-1)).toBe("Version");
      return ["252.39"];
    },
    close: async () => {},
    verify: () => {},
  });
  execFileMock.mockImplementation(async (_cmd, args, opts) => {
    if (args.includes("Version")) {
      expect(args).toContain("--auto-start=no");
      return failure("Failed to connect to bus");
    }
    expectUserCommand(args, "status");
    expect(opts?.env).toMatchObject({
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/systemd/private`,
    });
    return nativeExit();
  });
  await expect(
    isSystemdUserServiceAvailable({
      USER: "debian",
      XDG_RUNTIME_DIR: undefined,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-stale",
    }),
  ).resolves.toBe(true);
});

it.each(["access-denied", "missing-file", "manager-denied", "not-found"] as const)(
  "distinguishes absence from failed enablement inspection: %s",
  async (scenario) => {
    let env: NodeJS.ProcessEnv = { HOME: MANAGED_HOME };
    if (scenario === "missing-file") {
      vi.spyOn(fs, "access").mockRejectedValueOnce(
        Object.assign(new Error("missing unit"), { code: "ENOENT" }),
      );
    } else {
      vi.spyOn(fs, "access").mockResolvedValue(undefined);
    }
    if (scenario === "access-denied") {
      execFileMock.mockResolvedValue(
        failure("spawn systemctl EACCES", { errorCode: "EACCES", termination: "error" }),
      );
    } else if (scenario === "manager-denied") {
      env = { ...env, ...mockMachineManager("debian") };
      const probe = expectDefined(execFileMock.getMockImplementation(), "manager fixture");
      execFileMock.mockImplementation(async (command, args, options) => {
        if (args.includes("Version")) {
          return await probe(command, args, options);
        }
        expectMachineCommand(args, "debian", "is-enabled", GATEWAY_SERVICE);
        return failure("permission denied");
      });
    } else if (scenario === "not-found") {
      env = { ...env, OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: " custom-unit.service " };
      execFileMock.mockImplementationOnce(
        userResult(
          failure("Command failed: systemctl --user is-enabled custom-unit.service", {
            code: 4,
            stdout: "not-found\n",
          }),
          "is-enabled",
          "custom-unit.service",
        ),
      );
    }
    const enabled = isSystemdServiceEnabled({ env });
    if (scenario === "access-denied") {
      await expect(enabled).rejects.toMatchObject({ reason: "service-manager-access-denied" });
    } else if (scenario === "manager-denied") {
      await expect(enabled).rejects.toThrow(
        "systemctl --user is-enabled: exit 1; permission denied",
      );
    } else {
      await expect(enabled).resolves.toBe(false);
      if (scenario === "missing-file") {
        expect(execFileMock).not.toHaveBeenCalled();
      } else {
        expect(fs.access).toHaveBeenCalledWith(
          `${MANAGED_HOME}/.config/systemd/user/custom-unit.service`,
        );
      }
    }
  },
);
describe("system-scope gateway unit detection (openclaw#87577)", () => {
  function mockUnitFileLayout(layout: { user?: boolean; system?: string | false }) {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      const p = pathLikeToString(target);
      if ((layout.user && p.includes("/.config/systemd/user/")) || p === layout.system) {
        return;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  it("does not treat a custom marker-owned system gateway as dueling with the user unit", async () => {
    mockUnitFileLayout({ user: true, system: false });
    mockSystemMarker("openclaw-rescue");
    const installation = await findSystemdGatewayInstallation({ HOME: MANAGED_HOME });
    expect(installation.kind).toBe("user");
    expect(formatDuelingScopesWarning(installation, 18789)).toBeNull();
  });

  it("formatDuelingScopesWarning renders remediation only for the dueling state", () => {
    const warning = formatDuelingScopesWarning(
      {
        kind: "dueling",
        user: {
          scope: "user",
          unitName: GATEWAY_SERVICE,
          unitPath: `${MANAGED_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
        },
        system: {
          scope: "system",
          unitName: GATEWAY_SERVICE,
          unitPath: "/etc/systemd/system/openclaw-gateway.service",
        },
      },
      18789,
    );
    expect(warning).toContain("/.config/systemd/user/openclaw-gateway.service");
    expect(warning).toContain("/etc/systemd/system/openclaw-gateway.service");
    expect(warning).toContain("18789");
    expect(warning).toContain(
      "Run `openclaw doctor` interactively to inspect both scopes and review supported cleanup.",
    );
    expect(warning).not.toContain("rm ");
    expect(warning).not.toContain("disable --now");
  });

  it("does not adopt a system Gateway while inspecting the node service", async () => {
    mockUnitFileLayout({ system: false });
    mockSystemMarker();
    await expect(
      findInstalledSystemdGatewayScope({
        HOME: MANAGED_HOME,
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
      }),
    ).resolves.toBeNull();
  });

  it("isSystemdServiceEnabled queries the marker-owned custom system unit name", async () => {
    mockUnitFileLayout({ system: false });
    mockSystemMarker();
    execFileMock.mockImplementationOnce(
      nativeResult(["is-enabled", "openclaw.service"], nativeExit("enabled\n")),
    );
    await expect(isSystemdServiceEnabled({ env: { HOME: MANAGED_HOME } })).resolves.toBe(true);
  });

  it.each([false, true])("restarts system-scope units only as root (root=%s)", async (root) => {
    mockUnitFileLayout({ system: root ? "/etc/systemd/system/openclaw-gateway.service" : false });
    if (!root) {
      mockSystemMarker();
    }
    mockEffectiveUid(root ? 0 : 1000);
    if (root) {
      for (const action of ["reset-failed", "restart"]) {
        execFileMock.mockImplementationOnce(nativeResult([action, GATEWAY_SERVICE]));
      }
    }
    const { stdout, write } = captureOutput();
    const operation = restartSystemdService({ stdout, env: { HOME: MANAGED_HOME } });
    if (root) {
      await expect(operation).resolves.toEqual({ outcome: "completed" });
      expect(requireFirstWrite(write)).toContain("Restarted systemd service");
    } else {
      await expect(operation).rejects.toThrow(
        /openclaw\.service is a system-scope unit \(\/etc\/systemd\/system\/openclaw\.service\); run `sudo systemctl restart openclaw\.service`/,
      );
      expect(execFileMock).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
  });
});

describe("readSystemdServiceRuntime", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  });

  it.each(["availability", "command", "recorded-command"] as const)(
    "preserves unsettled native cleanup from runtime %s inspection",
    async (source) => {
      const error = new CommandProcessCleanupError();
      if (source === "command") {
        mockMissingBase();
      }
      execFileMock.mockImplementation(async (_command, args) => {
        if (source === "availability" || !args.includes("status")) {
          throw error;
        }
        return nativeExit();
      });

      await expect(
        readRuntime(
          { HOME: MANAGED_HOME },
          source === "availability"
            ? {
                systemdReadTarget: {
                  scope: "user",
                  unitName: GATEWAY_SERVICE,
                  unitPath: "/unused/openclaw-gateway.service",
                },
              }
            : source === "recorded-command"
              ? { commandInspection: { kind: "unavailable", error } }
              : undefined,
        ),
      ).rejects.toBe(error);
    },
  );

  it("does not hide a native ownership refusal as unknown runtime status", async () => {
    const error = new ServiceOwnershipRefusalError("systemd-manager-changed");
    versionFixture.useScenarioResponse = true;
    existsSync.mockImplementation((file) => pathLikeToString(file).endsWith("/systemd/private"));
    execFileMock.mockResolvedValue(failure("manager unavailable"));
    vi.spyOn(await import("./systemd-peer-native.js"), "openSystemdUserManager").mockRejectedValue(
      error,
    );

    await expect(
      readRuntime(
        { HOME: MANAGED_HOME },
        {
          systemdReadTarget: {
            scope: "user",
            unitName: GATEWAY_SERVICE,
            unitPath: "/unused/openclaw-gateway.service",
          },
        },
      ),
    ).rejects.toBe(error);
  });

  async function readRuntimeFromShowOutput(output: string) {
    execFileMock
      .mockReset()
      .mockImplementationOnce(userCommand("status"))
      .mockResolvedValueOnce(nativeExit(`LoadState=loaded\n${output}`));
    return await readRuntime({ HOME: MANAGED_HOME }, { commandInspection: { kind: "present" } });
  }

  it.each([
    {
      name: "activating/auto-restart is not stopped",
      output: "ActiveState=activating\nSubState=auto-restart\nMainPID=0",
      expected: { status: "unknown", state: "activating", subState: "auto-restart" },
    },
    {
      name: "inactive state rejects malformed numeric metrics",
      output:
        "ActiveState=inactive\nSubState=dead\nMainPID=42abc\nExecMainStatus=2ms\nExecMainCode=exited\nTasksCurrent=42abc\nMemoryCurrent=11GB",
      expected: {
        status: "stopped",
        pid: undefined,
        lastExitStatus: undefined,
        lastExitReason: "exited",
        systemd: { tasksCurrent: undefined, memoryCurrent: undefined },
      },
    },
  ])("reads native runtime state: $name", async ({ output, expected }) => {
    expect(await readRuntimeFromShowOutput(output)).toMatchObject(expected);
  });

  it.each(["absent", "unavailable"] as const)(
    "uses the recorded %s definition verdict without a competing show classification",
    async (kind) => {
      execFileMock.mockReset().mockImplementationOnce(userCommand("status"));
      const runtime = await readRuntime(
        { HOME: MANAGED_HOME },
        {
          commandInspection:
            kind === "absent"
              ? { kind }
              : { kind, error: new Error("definition-inspection-secret-canary") },
        },
      );
      if (kind === "absent") {
        expect(runtime).toEqual({
          status: "stopped",
          missingUnit: true,
          systemd: {
            transport: {
              kind: "session-bus",
              address: process.env.DBUS_SESSION_BUS_ADDRESS,
              runtimeDir: process.env.XDG_RUNTIME_DIR,
            },
          },
        });
      } else {
        expect(runtime).toMatchObject({
          status: "unknown",
          inspectionFailure: {
            detail: "SERVICE_DEFINITION_UNKNOWN: Service definition cannot be safely inspected.",
          },
        });
        expect(JSON.stringify(runtime)).not.toContain("secret-canary");
        expect(runtime.missingUnit).not.toBe(true);
      }
      expect(execFileMock).toHaveBeenCalledOnce();
    },
  );

  it("keeps unexpected systemctl failures visible", async () => {
    const detail = "Permission denied while reading systemd state";
    execFileMock
      .mockImplementationOnce(userCommand("status"))
      .mockResolvedValueOnce(failure(detail));

    await expect(
      readRuntime({ HOME: MANAGED_HOME }, { commandInspection: { kind: "present" } }),
    ).resolves.toMatchObject({
      status: "unknown",
      inspectionReason: undefined,
      inspectionFailure: {
        detail: expect.stringContaining(`systemctl --user show: exit 1; ${detail}`),
      },
      missingUnit: false,
    });
  });

  it("does not call an installed unit missing when systemd reports not-found", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (target !== "/etc/systemd/system/openclaw-gateway.service") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    execFileMock.mockResolvedValueOnce(
      nativeExit("LoadState=not-found\nActiveState=inactive\nSubState=dead"),
    );
    await expect(
      readRuntime({ HOME: MANAGED_HOME }, { commandInspection: { kind: "present" } }),
    ).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
    });
  });
});

describe("readSystemdServiceExecStart", () => {
  it("preserves unsettled cleanup instead of returning a managed command fallback", async () => {
    mockUnit(gatewayUnit());
    const error = new CommandProcessCleanupError();
    execFileMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(readCommand()).rejects.toBe(error);
  });

  it.each(["uid", "revoked-before", "revoked-load", "manager-change"] as const)(
    "reads a collected definition only with current recovery ownership (%s)",
    async (fault) => {
      mockUnit(gatewayUnit());
      let loaded = false;
      let owners = 0;
      const assertCurrent = vi.fn(() => {
        if (fault === "revoked-before" || (fault === "revoked-load" && loaded)) {
          throw new Error("source/executor revoked");
        }
      });
      execFileMock.mockImplementation(async (_command, args) => {
        let output: string;
        if (args.includes("GetUnit")) {
          const detail = `Call failed: Unit ${GATEWAY_SERVICE} not loaded.`;
          return failure(detail);
        }
        if (args.includes("GetNameOwner")) {
          output = JSON.stringify({
            type: "s",
            data: [++owners > 1 && fault === "manager-change" ? ":1.99" : ":1.42"],
          });
        } else if (args.includes("GetConnectionUnixUser")) {
          output = JSON.stringify({ type: "u", data: [2001] });
        } else if (args.includes("LoadUnit")) {
          loaded = true;
          output = JSON.stringify({
            type: "o",
            data: ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"],
          });
        } else if (args.includes("org.freedesktop.systemd1.Unit")) {
          output = unitProperties({});
        } else {
          output = serviceProperties({ programArguments: gatewayArguments });
        }
        return nativeExit(output);
      });
      const observed = readCommand({
        requireEffective: true,
        requireLoaded: true,
        loadForInspection: { managerUid: fault === "uid" ? 2002 : 2001, assertCurrent },
      });
      await expect(observed).rejects.toThrow();
      expect(loaded).toBe(!["uid", "revoked-before"].includes(fault));
      expect(assertCurrent).toHaveBeenCalled();
      expect(
        execFileMock.mock.calls.every(
          (call) =>
            (!call[1].includes("--json=short") || call[1].includes("--auto-start=no")) &&
            !call[1].some((arg) => /^(Start|Restart|Enable|Stop)Unit/.test(arg)),
        ),
      ).toBe(true);
    },
  );

  it("does not activate an unloaded global definition", async () => {
    execFileMock.mockReset();
    mockMissingBase();
    execFileMock.mockImplementation(async (_command, args) => {
      if (args.includes("GetUnitFileState")) {
        return nativeExit(JSON.stringify({ type: "s", data: ["disabled"] }));
      }
      const message = `Call failed: Unit ${GATEWAY_SERVICE} not loaded.`;
      return failure(message);
    });
    await expect(readCommand({ ...strict, requireLoaded: true })).rejects.toThrow(
      "could not be inspected",
    );
    expect(
      execFileMock.mock.calls.every(
        (call) => call[1].includes("GetUnit") || call[1].includes("GetUnitFileState"),
      ),
    ).toBe(true);
    expect(execFileMock.mock.calls.some((call) => call[1].includes("GetUnitFileState"))).toBe(true);
  });

  it("strictly distinguishes a missing base unit from an unreadable existing unit", async () => {
    execFileMock.mockResolvedValue(failure(`Call failed: Unit ${GATEWAY_SERVICE} not found.`));
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("missing service"), { code: "ENOENT" }),
    );
    await expect(readCommand(strict)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledWith(
      "busctl",
      expect.arrayContaining(["LoadUnit", GATEWAY_SERVICE]),
      expect.anything(),
    );

    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("unreadable-service-secret-canary"), { code: "EACCES" }),
    );
    await expect(readCommand(strict)).rejects.toThrow(
      `${SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
    );
  });

  it("reads a global user fragment instead of the local managed base", async () => {
    const fragmentPath = `/etc/systemd/user/${GATEWAY_SERVICE}`;
    const dropInPaths = [`/etc/systemd/user/${GATEWAY_SERVICE}.d/10-operator.conf`];
    vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
      if (file === "/etc/systemd/user/gateway.env") {
        return "OWNER=global\n";
      }
      return "[Service]\nExecStart=/usr/bin/managed gateway\n";
    });
    mockManager({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      fragmentPath,
      dropInPaths,
      environmentFiles: [["/etc/systemd/user/gateway.env", false]],
      needDaemonReload: true,
    });

    await expect(readCommand(strict)).resolves.toEqual({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      ...environmentSnapshot({ OWNER: ["global", "file"] }),
      sourcePath: fragmentPath,
      definitionPaths: [fragmentPath, ...dropInPaths],
      reloadPending: true,
    });
  });

  it("accepts manager LoadState=not-found before reading service properties", async () => {
    mockUnit(gatewayUnit());
    mockProperties(
      new Error("must not inspect a missing service"),
      unitProperties({ fragmentPath: "", loadState: "not-found" }),
    );
    await expect(readCommand(strict)).resolves.toBeNull();
  });

  it.each([
    { name: "wrong property types", output: JSON.stringify({ type: "s", data: "bad" }) },
    { name: "malformed LoadUnit", loaded: JSON.stringify({ type: "o", data: [] }) },
  ])("strictly rejects $name with a missing local base", async ({ output, loaded }) => {
    mockMissingBase();
    mockProperties(
      output ?? serviceProperties({ programArguments: ["/usr/bin/openclaw", "gateway"] }),
    );
    if (loaded) {
      execFileMock.mockResolvedValueOnce(nativeExit(loaded));
    }
    await expect(readCommand(strict)).rejects.toThrow();
    if (output) {
      await expect(readCommand()).resolves.toBeNull();
    }
  });

  it("enforces only active EnvironmentFile inputs (EACCES)", async () => {
    const inactive = `${SERVICE_HOME}/.openclaw/retired.env`;
    const active = `${SERVICE_HOME}/.openclaw/current.env`;
    const dropIn = `${SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/environment.conf`;
    mockUnit(gatewayUnit(`EnvironmentFile=${inactive}`), {
      [inactive]: Object.assign(new Error("retired environment unavailable"), { code: "EACCES" }),
      [active]: "ACTIVE_VALUE=current\n",
      [dropIn]: `[Service]\nEnvironmentFile=\nEnvironmentFile=${active}\n`,
    });
    mockManager({
      environmentFiles: [
        [active, false],
        [inactive, true],
      ],
      dropInPaths: [dropIn],
    });
    await expect(readCommand(strict)).resolves.toMatchObject({
      environment: { ACTIVE_VALUE: "current" },
      sourcePath: gatewayUnitPath,
      definitionPaths: [gatewayUnitPath, dropIn],
      managedOverrides: { environment: { keys: ["ACTIVE_VALUE"], resetFiles: true } },
    });
    mockManager({
      environmentFiles: [[inactive, false]],
    });
    await expect(readCommand(strict)).rejects.toThrow("retired environment unavailable");
  });

  it("reports one manager-effective command snapshot while retaining the managed base definition", async () => {
    const effectiveArguments = ["/opt/operator/openclaw", "gateway", "run"];
    const managedEnvironmentFile = `${SERVICE_HOME}/.openclaw/managed.env`;
    const effectiveEnvironmentFile = `${SERVICE_HOME}/.openclaw/operator.env`;
    const dropInPath = operatorDropIn;
    mockUnit(
      gatewayUnit(
        "WorkingDirectory=/srv/managed-openclaw",
        "Environment=BASE_INLINE=base BASE_SHARED=inline",
        `EnvironmentFile=${managedEnvironmentFile}`,
      ),
      {
        [managedEnvironmentFile]: "BASE_SHARED=file\nBASE_FILE=base\n",
        [dropInPath]: [
          "[Unit]",
          "WorkingDirectory=/ignored-unit-section",
          "[Service]",
          "ExecStart=",
          "ExecStart=/opt/operator/openclaw gateway run",
          "WorkingDirectory=/srv/operator-openclaw",
          "Environment=",
          "Environment=INLINE=inline \\",
          " SHARED=inline REMOVE_NAME=inline REMOVE_EXACT=inline",
          "EnvironmentFile=",
          `EnvironmentFile=${effectiveEnvironmentFile}`,
          "UnsetEnvironment=REMOVE_NAME REMOVE_EXACT=matching KEEP_EXACT=wrong",
        ].join("\n"),
        [effectiveEnvironmentFile]: [
          "SHARED=file",
          "FILE_ONLY=file",
          "REMOVE_NAME=file",
          "REMOVE_EXACT=matching",
          "KEEP_EXACT=actual",
        ].join("\n"),
      },
    );
    mockManager({
      programArguments: effectiveArguments,
      workingDirectory: "!/srv/operator-openclaw",
      environment: ["INLINE=inline", "SHARED=inline", "REMOVE_NAME=inline", "REMOVE_EXACT=inline"],
      environmentFiles: [[effectiveEnvironmentFile, false]],
      unsetEnvironment: ["REMOVE_NAME", "REMOVE_EXACT=matching", "KEEP_EXACT=wrong"],
      dropInPaths: [dropInPath],
    });
    let elapsed = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const execute = expectDefined(execFileMock.getMockImplementation(), "manager command fixture");
    let calls = 0;
    execFileMock.mockImplementation((...args) => {
      const response = execute(...args);
      elapsed += [100, 300, 0][calls++] ?? 0;
      return response;
    });

    const command = await readCommand({ timeoutMs: 1200, ...strict, requireLoaded: true });

    expect(command).toMatchObject({
      programArguments: effectiveArguments,
      workingDirectory: "/srv/operator-openclaw",
      ...environmentSnapshot({
        INLINE: ["inline", "inline"],
        SHARED: ["file", "inline-and-file"],
        FILE_ONLY: ["file", "file"],
        KEEP_EXACT: ["actual", "file"],
      }),
      managedDefinition: {
        programArguments: gatewayArguments,
        workingDirectory: "/srv/managed-openclaw",
        ...environmentSnapshot({
          BASE_INLINE: ["base", "inline"],
          BASE_SHARED: ["file", "inline-and-file"],
          BASE_FILE: ["base", "file"],
        }),
      },
      managedOverrides: {
        launcher: "command",
        environment: {
          keys: ["INLINE", "SHARED", "REMOVE_NAME", "REMOVE_EXACT", "FILE_ONLY", "KEEP_EXACT"],
          resetInline: true,
          resetFiles: true,
        },
      },
      sourcePath: gatewayUnitPath,
    });
    expect(execFileMock.mock.calls.map((call) => call[2]?.timeout)).toEqual([400, 550, 800]);
    expect(execFileMock.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
  });

  it("reports a working-directory override without a pending manager reload", async () => {
    const dropInPath = operatorDropIn;
    mockUnit(gatewayUnit(), {
      [dropInPath]: "[Service]\nWorkingDirectory=/srv/operator-openclaw",
    });
    mockManager({
      workingDirectory: "/srv/operator-openclaw",
      dropInPaths: [dropInPath],
      needDaemonReload: false,
    });

    const command = await readCommand();

    expect(command?.reloadPending).toBeUndefined();
    expect(command?.managedOverrides).toEqual({ launcher: "working-directory" });
  });

  it("retains loaded drop-in ownership after a backslash comment even when values equal the base", async () => {
    const comment = "# operator note \\";
    const dropInPath = operatorDropIn;
    mockUnit(
      gatewayUnit(
        "WorkingDirectory=/srv/openclaw",
        "Environment=OPENCLAW_GATEWAY_TOKEN=shared NODE_COMPILE_CACHE=/tmp/cache",
      ),
      {
        [dropInPath]: [
          "[Service]",
          comment,
          "ExecStart=",
          comment,
          "ExecStart=/usr/bin/openclaw gateway run",
          comment,
          "WorkingDirectory=/srv/openclaw",
          comment,
          "Environment=OPENCLAW_GATEWAY_TOKEN=shared NODE_COMPILE_CACHE=/tmp/cache",
        ].join("\n"),
      },
    );
    mockManager({
      workingDirectory: "/srv/openclaw",
      environment: ["OPENCLAW_GATEWAY_TOKEN=shared", "NODE_COMPILE_CACHE=/tmp/cache"],
      dropInPaths: [dropInPath],
    });

    const command = await readCommand();

    expect(command).toMatchObject({
      managedDefinition: { environment: { OPENCLAW_GATEWAY_TOKEN: "shared" } },
      managedOverrides: {
        launcher: "command",
        environment: { keys: ["OPENCLAW_GATEWAY_TOKEN", "NODE_COMPILE_CACHE"] },
      },
    });
  });

  it("preserves managed removals while clearing superseded drop-in ownership in directive order", async () => {
    const firstDropIn = `${SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/10-file.conf`;
    const resetDropIn = `${SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/20-reset.conf`;
    const operatorEnv = `${SERVICE_HOME}/.openclaw/operator.env`;
    mockUnit(gatewayUnit("Environment=FOO=base BAR=base", "UnsetEnvironment=BAR"), {
      [firstDropIn]: `[Service]\nEnvironmentFile=${operatorEnv}\n`,
      [resetDropIn]: "[Service]\nEnvironmentFile=\nUnsetEnvironment=FOO\nUnsetEnvironment=\n",
      [operatorEnv]: "FOO=operator\n",
    });
    mockManager({
      environment: ["FOO=base", "BAR=base"],
      dropInPaths: [firstDropIn, resetDropIn],
    });

    const command = await readCommand();

    expect(command).toMatchObject({
      programArguments: gatewayArguments,
      ...environmentSnapshot({ FOO: ["base", "inline"], BAR: ["base", "inline"] }),
      managedDefinition: { environment: { FOO: "base" } },
      managedOverrides: { environment: { keys: ["BAR"], resetFiles: true } },
      sourcePath: gatewayUnitPath,
    });
  });

  it("falls back to the coherent managed snapshot when pending reload state is malformed", async () => {
    const properties = unitProperties({}).replace(
      JSON.stringify({ type: "b", data: false }),
      JSON.stringify({ type: "b", data: "false" }),
    );
    mockUnit(
      gatewayUnit("WorkingDirectory=/srv/managed-openclaw", "Environment=MANAGED_VALUE=base"),
    );
    mockProperties(
      serviceProperties({
        programArguments: ["/opt/operator/openclaw", "gateway", "run"],
        environment: ["OPERATOR_VALUE=effective"],
      }),
      properties,
    );

    await expect(readCommand(strict)).rejects.toThrow();
    expect(execFileMock.mock.calls[0]?.[2]?.timeout).toBeLessThanOrEqual(Math.floor(5_000 / 3));
    const managedDefinition = {
      programArguments: gatewayArguments,
      workingDirectory: "/srv/managed-openclaw",
      ...environmentSnapshot({ MANAGED_VALUE: ["base", "inline"] }),
    };
    await expect(readCommand()).resolves.toMatchObject({
      ...managedDefinition,
      managedDefinition,
      managedOverrides: { launcher: "command", environment: true },
    });
  });

  it("applies managed directive resets before ordered environment assignments and removals", async () => {
    const staleFile = `${SERVICE_HOME}/.openclaw/stale.env`;
    const readFileSpy = mockUnit(
      gatewayUnit(
        "Environment=STALE_INLINE=discarded",
        "Environment=",
        'Environment=PLAIN=first "QUOTED=value with spaces" REPEATED=first \\',
        "  # ignored continuation comment",
        "  CONTINUED=second-line",
        "Environment='REPEATED=last value' INLINE_FILE=inline REMOVE_NAME=inline REMOVE_EXACT=inline KEEP_MISMATCH=inline",
        `EnvironmentFile=${staleFile}`,
        "EnvironmentFile=",
        "EnvironmentFile=-%h/.openclaw/optional-missing.env",
        "EnvironmentFile=%h/.openclaw/required-missing.env",
        "EnvironmentFile=%h/.openclaw/first.env",
        "EnvironmentFile=%h/.openclaw/.env",
        "EnvironmentFile=%h/.openclaw/second env.env",
        "UnsetEnvironment=PLAIN",
        "UnsetEnvironment=",
        "UnsetEnvironment=REMOVE_NAME",
        'UnsetEnvironment="REMOVE_EXACT=final value" KEEP_MISMATCH=wrong-value',
      ),
      {
        [staleFile]: "STALE_FILE=discarded\n",
        [`${SERVICE_HOME}/.openclaw/first.env`]: "FILE_ONLY=overridden\n",
        [`${SERVICE_HOME}/.openclaw/.env`]: [
          "INLINE_FILE=file",
          "FILE_ONLY=from-file",
          "REMOVE_NAME=file",
          "REMOVE_EXACT=final value",
          "KEEP_MISMATCH=file",
        ].join("\n"),
        [`${SERVICE_HOME}/.openclaw/second env.env`]: [
          "# comment",
          "; another comment",
          'SYMBOLS="symbol \\" \\\\ \\$ \\`"',
          'MIXED_API_KEY="55\\"55" "FIVE" cinco',
          'UNQUOTED_QUOTES_API_KEY=foo"bar"',
        ].join("\n"),
      },
    );
    mockProperties(new Error("systemd manager unavailable"));

    const command = await readCommand();

    const expected = environmentSnapshot({
      PLAIN: ["first", "inline"],
      QUOTED: ["value with spaces", "inline"],
      CONTINUED: ["second-line", "inline"],
      REPEATED: ["last value", "inline"],
      INLINE_FILE: ["file", "inline-and-file"],
      FILE_ONLY: ["from-file", "file"],
      KEEP_MISMATCH: ["file", "inline-and-file"],
      SYMBOLS: ['symbol " \\ $ `', "file"],
      MIXED_API_KEY: ['55"55FIVEcinco', "file"],
      UNQUOTED_QUOTES_API_KEY: ['foo"bar"', "file"],
    });
    expect(command?.environment).toEqual(expected.environment);
    expect(command?.environmentValueSources).toEqual(expected.environmentValueSources);
    expect(readFileSpy).not.toHaveBeenCalledWith(staleFile, "utf8");
  });
});

describe("stageSystemdService", () => {
  beforeEach(mockUninstalledManager);

  it("removes legacy gateway version metadata after a backslash comment without restarting", async () => {
    const comment = "# operator note \\";
    const { env, unitPath } = await fixture("gateway");
    await writeUnit(
      unitPath,
      [
        "[Unit]",
        "Description=OpenClaw Gateway (v2026.7.1-2)",
        "",
        "[Service]",
        comment,
        "ExecStart=/usr/bin/openclaw gateway run",
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw \\",
        "  # managed stamps span physical lines",
        "  OPENCLAW_SERVICE_KIND=gateway",
        'Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2 "OTHER_SETTING=kept value %h/%%h"',
        "Environment=OPENCLAW_GATEWAY_PORT=18789",
        "",
      ].join("\n"),
    );
    execFileMock.mockImplementationOnce(userCommand("daemon-reload"));

    await expect(refreshMetadata(env, 5_000)).resolves.toBe(true);

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unit).toContain("Description=OpenClaw Gateway\n");
    expect(unit).toContain('Environment="OTHER_SETTING=kept value %h/%%h"');
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(unit.split("\n")).toContain("ExecStart=/usr/bin/openclaw gateway run");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an unsafe legacy unit intact for full installer regeneration", async () => {
    const { env, unitPath } = await fixture("gateway");
    const previous = legacyGatewayUnit("2026.6.35", "ExecStart=/usr/bin/openclaw gateway");
    await writeUnit(unitPath, previous);
    await fs.chmod(unitPath, 0o664);

    await expect(refreshMetadata(env, 5_000)).resolves.toBe(false);

    await expectFiles({ [unitPath]: { contents: previous, mode: 0o664 } });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["reset managed markers", true, undefined],
    ["ownership refused before publication", false, 0],
    ["ownership refused after publication", false, 2],
  ] as const)("preserves legacy metadata: %s", async (_name, reset, admitted) => {
    const { env, unitPath } = await fixture("gateway");
    const previous = legacyGatewayUnit("2026.7.1-2", ...(reset ? ["Environment="] : []));
    await writeUnit(unitPath, previous);
    if (admitted !== undefined) {
      for (let index = 0; index < admitted; index++) {
        systemOwnership.mockResolvedValueOnce();
      }
      systemOwnership.mockRejectedValueOnce(new Error("system ownership"));
      await expect(refreshMetadata(env, 5_000)).rejects.toThrow("system ownership");
    } else {
      await expect(refreshMetadata(env, 5_000)).resolves.toBe(false);
      expect(systemOwnership).not.toHaveBeenCalled();
    }
    await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    [0, "unit", "system scope owns openclaw-gateway-stage-test.service"],
    [1, "none", "system ownership appeared"],
    [2, "both", "system ownership appeared"],
    [3, "none", "system ownership appeared before activation"],
  ] as const)(
    "preserves prior files when system ownership refuses publication at checkpoint %s",
    async (checkpoint, existing, error) => {
      const { env, unitPath, envFilePath } = await fixture("gateway");
      const previous = "[Unit]\nDescription=Previous gateway\n";
      const previousEnv = "OPENCLAW_GATEWAY_TOKEN=previous-token\n";
      if (existing !== "none") {
        await writeUnit(unitPath, previous, existing === "both" ? 0o400 : 0o644);
      }
      if (existing === "both") {
        await fs.writeFile(envFilePath, previousEnv, { encoding: "utf8", mode: 0o400 });
        await Promise.all([fs.chmod(unitPath, 0o400), fs.chmod(envFilePath, 0o400)]);
      }
      queueUserCommands(["status"]);
      for (let index = 0; index < checkpoint; index++) {
        systemOwnership.mockResolvedValueOnce();
      }
      if (checkpoint === 3) {
        systemOwnership.mockRejectedValue(new Error(error));
      } else {
        systemOwnership.mockRejectedValueOnce(new Error(error));
      }
      const withToken = checkpoint === 1 || checkpoint === 2;
      const args = serviceArgs(env, "gateway", {
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          ...(withToken ? { OPENCLAW_GATEWAY_TOKEN: "new-token" } : {}),
        },
        ...(withToken ? { environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" } } : {}),
      });
      await expect(
        (checkpoint === 3 ? installSystemdService : stageSystemdService)(args),
      ).rejects.toThrow(error);
      if (existing === "none") {
        await expectFiles({ [unitPath]: null });
      } else {
        await expectFiles({ [unitPath]: previous });
      }
      if (existing === "both") {
        await expectFiles({
          [unitPath]: { contents: previous, mode: 0o400 },
          [envFilePath]: { contents: previousEnv, mode: 0o400 },
        });
      } else if (checkpoint < 2) {
        await expectFiles({ [envFilePath]: null });
      }
      if (checkpoint === 0) {
        await expectFiles({ [`${unitPath}.bak`]: null });
        expect(systemOwnership).toHaveBeenCalledWith("openclaw-gateway-stage-test.service");
      }
      if (checkpoint === 3) {
        expect(execFileMock).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("round-trips file-backed secrets without adopting operator overrides", async () => {
    const { stage, env, unitPath, envFilePath } = await fixture("gateway");
    const dropInPath = `${unitPath}.d/operator.conf`;
    await writeUnit(dropInPath, "[Service]\nEnvironment=OPERATOR=kept\n");
    await stage({
      environment: {
        OPENAI_API_KEY: "file-backed-key",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY",
      },
      environmentValueSources: { OPENAI_API_KEY: "file" },
    });
    await expectFiles({ [envFilePath]: "OPENAI_API_KEY=file-backed-key\n" });
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("file-backed-key");
    mockManager({
      fragmentPath: unitPath,
      dropInPaths: [dropInPath],
      environment: ["OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY", "OPERATOR=kept"],
      environmentFiles: [[envFilePath, false]],
    });
    const command = await readServiceCommand(env, strict);
    expect(command).toMatchObject({
      ...environmentSnapshot({
        OPENAI_API_KEY: ["file-backed-key", "file"],
        OPERATOR: ["kept", "inline"],
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: ["OPENAI_API_KEY", "inline"],
      }),
      managedDefinition: { environment: { OPENAI_API_KEY: "file-backed-key" } },
      managedOverrides: { environment: { keys: ["OPERATOR"] } },
    });
    expect(command?.managedDefinition?.environment?.OPERATOR).toBeUndefined();
  });

  it("preserves the gateway environment while clearing node-managed values", async () => {
    const { env, unitPath, envFilePath, nodeEnvFilePath } = await fixture("gateway");
    const legacyGatewayEnvFile = "OPENCLAW_GATEWAY_TOKEN=stale-token\n";
    await fs.writeFile(envFilePath, legacyGatewayEnvFile, { encoding: "utf8", mode: 0o600 });
    await writeUnit(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-node-token\n", 0o600);
    queueUserCommands(["status"]);
    await stageSystemdService(
      serviceArgs(env, "node", {
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
      }),
    );
    const unit = await fs.readFile(unitPath, "utf8");
    expect(unit).not.toContain("EnvironmentFile=");
    await expectFiles({ [nodeEnvFilePath]: "", [envFilePath]: legacyGatewayEnvFile });
  });

  it("protects tokenless gateway units and backups from legacy credentials", async () => {
    const { stage, unitPath } = await fixture("gateway");
    await writeUnit(
      unitPath,
      [
        "[Service]",
        "# operator note \\",
        "ExecStart=/opt/operator/openclaw gateway run --operator-flag",
        "# operator note \\",
        "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept \\",
        "  # legacy installer note",
        "  OPENCLAW_GATEWAY_PASSWORD=legacy-password",
        "Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line",
        "Environment='OPENCLAW_GATEWAY_TOKEN=single-quoted-token' FROM_SINGLE=kept",
        "Environment=",
        "Environment=FILE_ONLY_SECRET=old-file-value",
      ].join("\n"),
    );
    await fs.chmod(unitPath, 0o644);
    await stage({
      environment: { OPENCLAW_GATEWAY_PORT: "18789", FILE_ONLY_SECRET: "fresh-file-value" },
      environmentValueSources: { FILE_ONLY_SECRET: "file" },
    });

    const [unit, backup, unitStat, backupStat] = await Promise.all([
      fs.readFile(unitPath, "utf8"),
      fs.readFile(`${unitPath}.bak`, "utf8"),
      fs.stat(unitPath),
      fs.stat(`${unitPath}.bak`),
    ]);
    for (const contents of [unit, backup]) {
      expect(contents).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(contents).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    }
    expect(backup.split("\n")).toContain(
      "ExecStart=/opt/operator/openclaw gateway run --operator-flag",
    );
    expect(backup).toContain("CUSTOM_SETTING=kept");
    expect(backup.split("\n")).toContain("Environment=FROM_SINGLE=kept");
    expect(backup.split("\n")).toContain("Environment=");
    expect(backup).not.toContain("FILE_ONLY_SECRET");
    expect(unit).not.toContain("fresh-file-value");
    expect(unitStat.mode & 0o777).toBe(0o600);
    expect(backupStat.mode & 0o777).toBe(0o600);
  });

  it("restores an orphan backup when later staging fails", async () => {
    const { stage, unitPath } = await fixture("gateway");
    const backupPath = `${unitPath}.bak`;
    const previous =
      "[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept\n";
    await writeUnit(backupPath, previous, 0o640);
    await fs.chmod(backupPath, 0o640);
    await expect(
      stage({
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "invalid\nmultiline",
        },
        environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
      }),
    ).rejects.toThrow("systemd EnvironmentFile values must be single-line");

    await expectFiles({ [backupPath]: { contents: previous, mode: 0o640 }, [unitPath]: null });
  });

  it("clears stale inline-managed keys from env file on re-stage (#76860)", async () => {
    const { stage, stateDir, unitPath, envFilePath } = await fixture("gateway");
    await writeUnit(
      unitPath,
      "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=STALE_MANAGED_KEY\n",
    );
    await writeUnit(
      envFilePath,
      [
        "OPENCLAW_GATEWAY_TOKEN=stale-gateway-token",
        "OPENROUTER_API_KEY=or-operator-key",
        "NODE_OPTIONS=--require=/tmp/stale-preload.cjs",
        "STALE_MANAGED_KEY=stale-managed",
      ].join("\n") + "\n",
      0o600,
    );

    await writeUnit(
      path.join(stateDir, ".env"),
      "LLM_API_KEY=dotenv-key\nOPENCLAW_GATEWAY_TOKEN=stale-token\ntoString=dotenv-string\n",
      0o600,
    );

    await stage({
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "fresh-gateway-token",
        LLM_API_KEY: "dotenv-key",
        constructor: "inline-constructor",
        toString: "dotenv-string",
        OPENROUTER_API_KEY: "or-operator-key",
        NODE_OPTIONS: "",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
      },
      environmentValueSources: {
        OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
        LLM_API_KEY: "inline",
        OPENROUTER_API_KEY: "file",
        NODE_OPTIONS: "inline",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
      },
    });

    const [unit, envFile] = await Promise.all([
      fs.readFile(unitPath, "utf8"),
      fs.readFile(envFilePath, "utf8"),
    ]);
    expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    for (const key of [
      "OPENCLAW_GATEWAY_TOKEN",
      "NODE_OPTIONS",
      "STALE_MANAGED_KEY",
      "LLM_API_KEY",
    ]) {
      expect(envFile).not.toContain(key);
    }
    expect(unit).toContain("Environment=NODE_OPTIONS=\n");
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-gateway-token");
    expect(unit).toContain("Environment=constructor=inline-constructor");
    expect(unit).not.toContain("Environment=toString=dotenv-string");
    expect(unit).not.toContain("Environment=OPENROUTER_API_KEY=or-operator-key");
    expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
  });

  it("keeps an operator secret that merely shares a name absent from state-dir .env (#88274)", async () => {
    const { stage, stateDir, unitPath, envFilePath } = await fixture("gateway");
    await writeUnit(
      envFilePath,
      [
        "ANTHROPIC_API_KEY=sk-ant-operator-secret",
        "LOWERCASE_LITERAL_API_KEY=$ecret123",
        "LLM_API_KEY=$SECRET_FROM_SHELL",
        "STALE_ABSENT_KEY=$SECRET_FROM_SHELL",
        "UNRESOLVED_INLINE_KEY=$SECRET_FROM_SHELL",
        "ESCAPED_LITERAL_API_KEY=\\$SECRET_FROM_SHELL",
        "SINGLE_QUOTED_LITERAL_API_KEY='$SECRET_FROM_SHELL'",
        'DOUBLE_QUOTED_LITERAL_API_KEY="$SECRET_FROM_SHELL"',
      ].join("\n") + "\n",
      0o600,
    );

    await writeUnit(path.join(stateDir, ".env"), "LLM_API_KEY=${UNRESOLVED}\n", 0o600);

    await stage({
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        UNRESOLVED_INLINE_KEY: "$SECRET_FROM_SHELL",
      },
      environmentValueSources: { UNRESOLVED_INLINE_KEY: "inline-and-file" },
    });

    const envFile = await fs.readFile(envFilePath, "utf8");
    expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
    expect(envFile).toContain('LOWERCASE_LITERAL_API_KEY="\\$ecret123"');
    for (const key of ["ESCAPED_LITERAL", "SINGLE_QUOTED_LITERAL", "DOUBLE_QUOTED_LITERAL"]) {
      expect(envFile).toContain(`${key}_API_KEY="\\$SECRET_FROM_SHELL"`);
    }
    for (const key of ["LLM_API_KEY", "STALE_ABSENT_KEY", "UNRESOLVED_INLINE_KEY"]) {
      expect(envFile).not.toContain(key);
    }
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("UNRESOLVED_INLINE_KEY");
  });
});

describe("systemd service install and uninstall", () => {
  beforeEach(mockUninstalledManager);

  it("preserves disabled autostart when installing a node unit", async () => {
    const { install, unitPath } = await fixture("node");
    queueUserCommands(["status"], ["daemon-reload"], ["restart", NODE_SERVICE]);

    await install({ preserveAutoStart: true, description: "OpenClaw Node Host" });

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unitPath).toMatch(/openclaw-node\.service$/);
    expect(unit).toContain("Description=OpenClaw Node Host");
    expect(unit).toContain("openclaw node run");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
  });

  it.each([
    ["an equal-valued launcher override", "ExecStart=/usr/bin/openclaw node run", true],
    ["an environment-only override", "Environment=NODE_COMPILE_CACHE=/tmp/cache", false],
  ] as const)(
    "warns after installation only when %s controls the effective launcher",
    async (_name, directive, shouldWarn) => {
      const { install, unitPath } = await fixture("node");
      const dropInPath = path.join(`${unitPath}.d`, "operator.conf");
      await writeUnit(dropInPath, `[Service]\n${directive}\n`);
      await writeUnit(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n");
      mockNodeManager(unitPath, [dropInPath]);
      const warn = vi.fn();

      await install({ warn });

      if (shouldWarn) {
        expect(warn).toHaveBeenCalledWith(
          "Systemd drop-in overrides the managed service command or working directory; inspect, update, or remove the drop-in because reinstalling the base unit does not change the effective launcher.",
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["ordinary", "cleanup"] as const)(
    "keeps post-install inspection failures distinct: %s",
    async (kind) => {
      const { env, unitPath } = await fixture("node");
      await writeUnit(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n");
      const inspectionError =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new Error("fixture optional inspection failure");
      let failed = false;
      mockNodeManager(unitPath, [], () => {
        failed = true;
        throw inspectionError;
      });
      const { write, stdout } = captureOutput();
      const operation = installSystemdService({
        ...serviceArgs(env, "node", { warn: vi.fn() }),
        stdout,
      });

      if (kind === "ordinary") {
        await expect(operation).resolves.toEqual({ unitPath });
        expect(write).toHaveBeenCalled();
      } else {
        await expect(operation).rejects.toBe(inspectionError);
        expect(write).not.toHaveBeenCalled();
      }
      expect(failed).toBe(true);
    },
  );

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    const { install } = await fixture("node");
    queueUserCommands(["status"], ["daemon-reload"]);
    execFileMock.mockImplementationOnce(
      userResult(
        failure("Unit file openclaw-node.service does not exist."),
        "enable",
        NODE_SERVICE,
      ),
    );
    queueUserCommands(["daemon-reload"], ["enable", NODE_SERVICE], ["restart", NODE_SERVICE]);
    await install();
  });

  it("does not retry an interrupted restart reporting a missing unit (signal)", async () => {
    const { install } = await fixture("node");
    execFileMock.mockResolvedValue(nativeExit());
    queueUserCommands(["status"], ["daemon-reload"], ["enable", NODE_SERVICE]);
    execFileMock.mockImplementationOnce(
      userResult(
        failure("Unit file openclaw-node.service does not exist.", { termination: "signal" }),
        "restart",
        NODE_SERVICE,
      ),
    );

    await expect(install()).rejects.toThrow("systemctl restart failed:");
    expectActions(
      "status",
      "daemon-reload",
      "enable",
      "restart",
      "daemon-reload",
      "disable",
      "stop",
    );
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    const { install } = await fixture("node");
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no user info");
    });
    mockNodeInstallNoMediumFailure();

    await expect(install()).rejects.toThrow(
      "systemctl --user unavailable: Failed to connect to bus: No medium found",
    );

    expect(execFileMock.mock.calls.map(([, args]) => args)).toEqual([
      ["--user", "status"],
      ["--user", "daemon-reload"],
      ["--user", "enable", NODE_SERVICE],
      ["--user", "daemon-reload"],
    ]);
  });

  it("refuses to remove the unit when systemctl disable fails", async () => {
    const detail =
      "Failed to disable unit: Access denied.\nUnit openclaw-node.service is not active.";
    const { env, unitPath, nodeEnvFilePath } = await fixture("node");
    await writeUnit(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
    await writeUnit(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=preserved-token\n", 0o600);
    execFileMock
      .mockImplementationOnce(userCommand("status"))
      .mockImplementationOnce(userFailure(detail, "disable", "--now", NODE_SERVICE));

    const { stdout } = captureOutput();

    await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
      `systemctl disable failed: ${detail}`,
    );
    await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
    await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toContain("preserved-token");
  });

  it("keeps missing or inactive systemd unit removal idempotent", async () => {
    const detail = "Failed to stop openclaw-node.service: Unit openclaw-node.service not loaded.";
    const { env } = await fixture("node");
    execFileMock
      .mockImplementationOnce(userCommand("status"))
      .mockImplementationOnce(userFailure(detail, "disable", "--now", NODE_SERVICE));

    const { write, stdout } = captureOutput();

    await expect(uninstallSystemdService({ env, stdout })).resolves.toBeUndefined();
    expect(requireFirstWrite(write)).toContain("Systemd service not found");
  });

  it.each([
    "operator-values",
    "password-only",
    "unlink-refused",
    "read-refused",
    "reload-failed",
  ] as const)(
    "uninstalls the selected node unit and cleans credentials only after removal: %s",
    async (scenario) => {
      const { env, unitPath, nodeEnvFilePath } = await fixture("node");
      await writeUnit(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
      if (scenario !== "password-only") {
        await writeUnit(`${unitPath}.bak`, "[Unit]\nDescription=Previous OpenClaw Node\n");
      }
      const retained =
        ["OPENROUTER_API_KEY=operator-key", 'LITERAL_API_KEY="\\$SECRET_FROM_SHELL"'].join("\n") +
        "\n";
      const previous =
        scenario === "password-only"
          ? "OPENCLAW_GATEWAY_PASSWORD=stale-password\n"
          : scenario === "unlink-refused"
            ? "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n"
            : [
                "OPENCLAW_GATEWAY_TOKEN=stale-node-token",
                "OPENCLAW_GATEWAY_PASSWORD=stale-password",
                "OPENROUTER_API_KEY=operator-key",
                "LLM_API_KEY=$SECRET_FROM_SHELL",
                "LITERAL_API_KEY=\\$SECRET_FROM_SHELL",
              ].join("\n") + "\n";
      if (scenario === "read-refused") {
        await fs.mkdir(nodeEnvFilePath);
      } else {
        await fs.writeFile(nodeEnvFilePath, previous, { encoding: "utf8", mode: 0o600 });
      }
      queueUserCommands(["status"], ["disable", "--now", NODE_SERVICE]);
      if (scenario === "unlink-refused") {
        vi.spyOn(fs, "unlink").mockRejectedValueOnce(
          Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
        );
      } else {
        execFileMock.mockImplementationOnce(
          userResult(
            scenario === "reload-failed" ? failure("Bus unavailable") : nativeExit(),
            "daemon-reload",
          ),
        );
      }
      const { write, stdout } = captureOutput();
      const operation = uninstallSystemdService({ env, stdout });
      if (scenario === "reload-failed") {
        await expect(operation).rejects.toThrow("systemctl daemon-reload failed: Bus unavailable");
        await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(retained);
      } else if (scenario === "unlink-refused") {
        await expect(operation).rejects.toThrow("EACCES: permission denied");
        await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
        await expect(fs.readFile(`${unitPath}.bak`, "utf8")).resolves.toContain(
          "Previous OpenClaw Node",
        );
        await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(previous);
      } else if (scenario === "read-refused") {
        await expect(operation).rejects.toMatchObject({ code: "EISDIR" });
        await expectFiles({ [unitPath]: null, [`${unitPath}.bak`]: null });
        expect((await fs.stat(nodeEnvFilePath)).isDirectory()).toBe(true);
        expect(write).not.toHaveBeenCalled();
      } else {
        await operation;
        await expectFiles({ [unitPath]: null, [`${unitPath}.bak`]: null });
        if (scenario === "password-only") {
          await expect(fs.access(nodeEnvFilePath)).rejects.toThrow();
        } else {
          await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(retained);
          expect(requireFirstWrite(write)).toContain("Removed systemd service");
        }
      }
      expect(execFileMock).toHaveBeenCalledTimes(
        scenario === "unlink-refused" || scenario === "read-refused" ? 2 : 3,
      );
      if (scenario !== "unlink-refused" && scenario !== "read-refused") {
        expectActions("status", "disable", "daemon-reload");
      }
    },
  );
});

describe("isSystemUnitActiveAndEnabled", () => {
  it("keeps failed user activity probes distinguishable from inactivity", async () => {
    const detail = "Failed to connect to bus: Permission denied";
    execFileMock.mockResolvedValue(failure(detail));
    await expect(
      isSystemdUnitActive({ HOME: MANAGED_HOME }, GATEWAY_SERVICE, "user"),
    ).resolves.toEqual({ ok: false, error: detail });
  });

  it.each([
    ["inactive", 3, null, "enabled"],
    ["disabled", null, 1, ""],
    ["runtime-only enablement", null, null, "enabled-runtime"],
  ] as const)(
    "authorizes system-unit adoption only with persistent availability: %s",
    async (_name, active, enabled, state) => {
      execFileMock.mockImplementationOnce(
        nativeResult(
          ["is-active", "--quiet", GATEWAY_SERVICE],
          active ? failure("inactive or interrupted", { code: active }) : nativeExit(),
        ),
      );
      if (!active) {
        execFileMock.mockImplementationOnce(
          nativeResult(
            ["is-enabled", GATEWAY_SERVICE],
            enabled
              ? failure("disabled", { code: enabled, stdout: `${state}\n` })
              : nativeExit(`${state}\n`),
          ),
        );
      }
      await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
      expect(execFileMock).toHaveBeenCalledTimes(active ? 1 : 2);
    },
  );
});

describe("uninstallLegacySystemdUnits", () => {
  it.each([
    ["", "EACCES"],
    [".bak", "EIO"],
  ])("reports legacy %s inspection failure %s before cleanup", async (suffix, code) => {
    const env = { HOME: tempDirs.make("openclaw-legacy-inspection-") };
    const unitPath = path.join(env.HOME, ".config/systemd/user/clawdbot-gateway.service");
    const inspectedPath = `${unitPath}${suffix}`;
    const definition = "[Unit]\nDescription=Legacy inspection fixture\n";
    await writeUnit(inspectedPath, definition);
    const inspectionError = Object.assign(new Error("legacy inspection failed"), { code });
    vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
      if (pathLikeToString(pathname) === inspectedPath) {
        throw inspectionError;
      }
      return access(pathname, mode);
    });
    execFileMock.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? nativeExit("systemd 252")
        : failure("disabled", { stdout: "disabled" }),
    );
    const { write, stdout } = captureOutput();

    await expect(uninstallLegacySystemdUnits({ env, stdout })).rejects.toBe(inspectionError);
    await expect(fs.readFile(inspectedPath, "utf8")).resolves.toBe(definition);
    expect(write).not.toHaveBeenCalled();
  });

  it("discovers and removes an orphaned legacy backup", async () => {
    const tempHomeRoot = tempDirs.make("openclaw-legacy-backup-");
    const env = { HOME: path.join(tempHomeRoot, "home") };
    const backupPath = path.join(
      env.HOME,
      ".config",
      "systemd",
      "user",
      "clawdbot-gateway.service.bak",
    );
    await writeUnit(backupPath, "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token\n", 0o600);
    execFileMock.mockImplementation(async (_command, args) =>
      args[1] === "is-enabled" ? failure("disabled", { stdout: "disabled" }) : nativeExit(),
    );

    const units = await uninstallLegacySystemdUnits({
      env,
      stdout: captureOutput().stdout,
    });

    expect(units).toMatchObject([{ name: "clawdbot-gateway" }]);
    await expectFiles({ [backupPath]: null });
  });
});

it.each(["absent", "reload-failed"] as const)(
  "removes only safely disabled user units: %s",
  async (scenario) => {
    const { env, unitPath } = await fixture("user");
    const unitName = GATEWAY_SERVICE;
    if (scenario !== "absent") {
      await writeUnit(unitPath, "[Unit]\nDescription=OpenClaw Gateway\n");
    }
    if (scenario === "absent") {
      await writeUnit(
        `${unitPath}.bak`,
        "Environment=OPENCLAW_GATEWAY_TOKEN=orphaned-token\n",
        0o600,
      );
    }
    execFileMock
      .mockImplementationOnce(nativeResult(["--version"]))
      .mockImplementationOnce(userCommand("disable", "--now", unitName));
    if (scenario === "reload-failed") {
      execFileMock.mockImplementationOnce(userResult(failure("Bus unavailable"), "daemon-reload"));
    }
    const { write, stdout } = captureOutput();
    const operation = uninstallUserSystemdGatewayUnit({ env, stdout });
    if (scenario === "reload-failed") {
      await expect(operation).rejects.toThrow("systemctl daemon-reload failed: Bus unavailable");
    } else {
      expect(await operation).toMatchObject({
        unitName,
        unitPath,
        removed: scenario !== "absent",
        disabled: true,
      });
    }
    await expectFiles({ [unitPath]: null });
    if (scenario === "absent") {
      await expectFiles({ [`${unitPath}.bak`]: null });
    }
    if (scenario === "absent") {
      expect(requireFirstWrite(write)).toContain("User-scope systemd unit not found");
    }
  },
);
describe("systemd service control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    systemOwnership.mockReset();
    systemOwnership.mockResolvedValue();
    vi.spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("missing fixture unit"), { code: "ENOENT" }),
    );
  });

  it("checks system ownership for the selected legacy user unit", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      const p = pathLikeToString(target);
      if (p.includes("/.config/systemd/user/") && p.endsWith("/openclaw-lisa.service")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    systemOwnership.mockRejectedValueOnce(new Error("same-name system ownership"));
    execFileMock.mockResolvedValueOnce(nativeExit());

    await expect(
      startSystemdService({
        stdout: captureOutput().stdout,
        env: { HOME: MANAGED_HOME, OPENCLAW_PROFILE: "lisa" },
      }),
    ).rejects.toThrow("same-name system ownership");

    expect(systemOwnership).toHaveBeenCalledWith("openclaw-lisa.service");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("reports the start mutation before output despite observer failure", async () => {
    const sequence: string[] = [];
    execFileMock.mockResolvedValueOnce(nativeExit());
    execFileMock.mockImplementationOnce(async (_cmd, args) => {
      expectUserCommand(args, "reset-failed", GATEWAY_SERVICE);
      sequence.push(args[1] ?? "");
      return failure(`Unit ${GATEWAY_SERVICE} not loaded.`);
    });
    execFileMock.mockImplementationOnce(async (_cmd, args) => {
      expectUserCommand(args, "start", GATEWAY_SERVICE);
      sequence.push(args[1] ?? "");
      return nativeExit();
    });
    const write = vi.fn();
    const onMutation = vi.fn(() => {
      throw new Error("audit failed");
    });
    const operation = startSystemdService({
      stdout: captureOutput(write).stdout,
      env: { HOME: MANAGED_HOME },
      onMutation,
    });
    await expect(operation).resolves.toBeUndefined();
    expect(sequence).toEqual(["reset-failed", "start"]);
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[0], "start audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
    expect(requireFirstWrite(write)).toContain("Started systemd service");
    expect(onMutation).toHaveBeenCalledWith({ mode: "systemctl-start" });
  });

  it("surfaces unavailable user-manager stop failures", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockResolvedValue(failure("Failed to connect to bus"));
    const operation = stopSystemdService({
      stdout: captureOutput().stdout,
      env: { HOME: MANAGED_HOME, USER: "", LOGNAME: "" },
    });
    await expect(operation).rejects.toMatchObject({ reason: "systemd-user-bus-unavailable" });
  });

  it.each([false, true])(
    "restarts the sudo caller unless a root manager is explicit (%s)",
    async (rootManager) => {
      mockEffectiveUid(0);
      const env = rootManager
        ? {
            HOME: "/root",
            USER: "root",
            LOGNAME: "root",
            SUDO_USER: "debian",
            XDG_RUNTIME_DIR: "/run/user/0",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
          }
        : {
            HOME: MANAGED_HOME,
            SUDO_USER: "debian",
            USER: "root-env-stale",
            LOGNAME: "root-env-stale",
          };
      if (rootManager) {
        vi.spyOn(os, "userInfo").mockReturnValue({
          username: "root",
          uid: 0,
          gid: 0,
          shell: "/bin/bash",
          homedir: "/root",
        });
      }
      const success = (...args: string[]) =>
        rootManager ? userCommand(...args) : machineCommand("debian", ...args);
      execFileMock
        .mockImplementationOnce(success("status"))
        .mockImplementationOnce(success("reset-failed", GATEWAY_SERVICE))
        .mockImplementationOnce(success("restart", GATEWAY_SERVICE));
      expect(resolveSystemdUserServiceAccount(env)).toBe(rootManager ? "root" : "debian");
      expect(hasSudoToRootSystemdUserManagerMismatch(env)).toBe(!rootManager);
      await assertRestartSuccess(env);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
