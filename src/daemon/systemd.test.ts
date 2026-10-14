import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Systemd tests cover Linux service install, start, stop, and status behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import type { ExecResult } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput as serializeSystemdUnitProperties,
  pathLikeToString,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import {
  createExecFileError,
  type ExecFileError,
  type ExecFileMock,
} from "./systemd-exec.test-support.js";

const execFileMock = vi.hoisted(() => vi.fn<ExecFileMock>());
const versionFixture = vi.hoisted(() => ({ useScenarioResponse: false }));
const existsSyncMock = vi.hoisted(() => vi.fn<typeof import("node:fs").existsSync>(() => false));
const assertNoSystemSystemdOwnershipMock = vi.hoisted(() =>
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
    timeoutMs === undefined
      ? assertNoSystemSystemdOwnershipMock(unitName)
      : assertNoSystemSystemdOwnershipMock(unitName, timeoutMs),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

vi.mock("./exec-file.js", () => {
  return {
    execFileUtf8: async (
      command: string,
      args: string[],
      options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
    ): Promise<ExecResult> => {
      if (args.includes("Version")) {
        expect(command).toBe("busctl");
        expect(args).toEqual([
          ...(args[0] === "--machine"
            ? ["--machine", `${options.env?.USER}@`, "--user"]
            : ["--user"]),
          "--auto-start=no",
          "get-property",
          "org.freedesktop.systemd1",
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          "Version",
        ]);
        if (!versionFixture.useScenarioResponse) {
          return { code: 0, termination: "exit", stdout: 's "252.39"', stderr: "" };
        }
      }
      let settled: ExecResult | undefined;

      execFileMock(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
        settled = {
          stdout: stdout ?? "",
          stderr: stderr || error?.message || "",
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          termination: error?.termination ?? (typeof error?.code === "string" ? "error" : "exit"),
          errorCode: typeof error?.code === "string" ? error.code : undefined,
        };
      });

      if (!settled) {
        throw new Error(`execFile mock did not settle for ${command} ${args.join(" ")}`);
      }
      return settled;
    },
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
  readSystemdServiceRuntime,
  readSystemdServiceExecStart,
  refreshLegacySystemdServiceMetadata,
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
const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";
const NODE_SERVICE = "openclaw-node.service";

const createWritableStreamMock = (write = vi.fn()) => {
  const stdout = { write };
  return {
    write,
    stdout: stdout as typeof stdout & NodeJS.WritableStream,
  };
};

type SystemdServiceFixture = Parameters<typeof stageSystemdService>[0];
type SystemdServiceFixtureOverrides = Omit<
  SystemdServiceFixture,
  "env" | "stdout" | "programArguments"
>;

function systemdServiceFixture(
  env: SystemdServiceFixture["env"],
  programArguments: string[],
  overrides: SystemdServiceFixtureOverrides = {},
): SystemdServiceFixture {
  return { env, stdout: createWritableStreamMock().stdout, programArguments, ...overrides };
}

function gatewaySystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  overrides: Omit<SystemdServiceFixtureOverrides, "workingDirectory"> = {},
): SystemdServiceFixture {
  return systemdServiceFixture(env, ["/usr/bin/openclaw", "gateway", "run"], {
    workingDirectory: "/tmp",
    ...overrides,
  });
}

function nodeSystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  overrides: Omit<SystemdServiceFixtureOverrides, "workingDirectory"> = {},
): SystemdServiceFixture {
  return systemdServiceFixture(env, ["/usr/bin/openclaw", "node", "run"], {
    workingDirectory: "/tmp",
    ...overrides,
  });
}

function gatewayPortSystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  port: string,
): SystemdServiceFixture {
  return gatewaySystemdServiceFixture(env, { environment: { OPENCLAW_GATEWAY_PORT: port } });
}

async function writeUnitFixture(unitPath: string, contents: string, mode = 0o644) {
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
  await fs.writeFile(unitPath, contents, { encoding: "utf8", mode });
}

async function createSystemdFixture(kind: "gateway" | "node" | "user") {
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
  };
}

function requireFirstWrite(write: ReturnType<typeof vi.fn>): string {
  const [call] = write.mock.calls;
  if (!call) {
    throw new Error("expected systemd status write");
  }
  const [value] = call;
  if (value === undefined) {
    throw new Error("expected systemd status write");
  }
  return String(value);
}

function assertUserSystemctlArgs(args: string[], ...command: string[]) {
  expect(args).toEqual(["--user", ...command]);
}

function assertMachineUserSystemctlArgs(args: string[], user: string, ...command: string[]) {
  expect(args).toEqual(["--machine", `${user}@`, "--user", ...command]);
}

function systemctlUserSuccess(...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertUserSystemctlArgs(args, ...command);
    cb(null, "", "");
  };
}

function systemctlMachineUserSuccess(user: string, ...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertMachineUserSystemctlArgs(args, user, ...command);
    cb(null, "", "");
  };
}

function execFileSuccess(): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(null, "", "");
}

type ExecFileResult = [error: ExecFileError | null, stdout: string, stderr: string];

function systemctlVersionResult(result: ExecFileResult = [null, "", ""]): ExecFileMock {
  return (_command, args, _options, done) => {
    expect(args).toEqual(["--version"]);
    done(...result);
  };
}

function systemctlUserResult(result: ExecFileResult, ...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertUserSystemctlArgs(args, ...command);
    cb(...result);
  };
}

function execFileResult(...result: ExecFileResult): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(...result);
}

function mockNodeInstallNoMediumFailure(): void {
  const unavailable: ExecFileResult = [
    createExecFileError("Failed to connect to bus: No medium found", {
      stderr: "Failed to connect to bus: No medium found",
    }),
    "",
    "",
  ];
  execFileMock
    .mockImplementationOnce(systemctlUserSuccess("status"))
    .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
    .mockImplementationOnce(systemctlUserResult(unavailable, "enable", NODE_SERVICE));
  execFileMock.mockImplementationOnce(systemctlUserResult(unavailable, "disable", NODE_SERVICE));
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
  execFileMock.mockReset().mockImplementation((_command, args, _options, done) => {
    if (args.includes("Version") && !args.includes("--machine")) {
      done(
        createExecFileError("Failed to connect to bus: No medium found"),
        "",
        "Failed to connect to bus: No medium found",
      );
      return;
    }
    expect(args.slice(0, 3)).toEqual(["--machine", `${user}@`, "--user"]);
    done(null, args.includes("Version") ? 's "252.39"' : "", "");
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

function mockReadGatewayServiceFile(
  unitLines: string[],
  extraFiles: Record<string, string | Error> = {},
) {
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

function buildSystemdUnitPropertyOutput(
  params: Pick<
    SystemdManagerSnapshotFixture,
    "fragmentPath" | "dropInPaths" | "needDaemonReload" | "loadState"
  >,
): string {
  return serializeSystemdUnitProperties({
    ...params,
    fragmentPath:
      params.fragmentPath ?? `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
  });
}

function mockSystemdManagerProperties(
  output: string | Error,
  unitOutput: string | Error = buildSystemdUnitPropertyOutput({}),
): void {
  vi.spyOn(systemdExec, "execBusctlUser").mockRestore();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    const propertyOutput =
      args.includes("LoadUnit") || args.includes("GetUnit")
        ? JSON.stringify({
            type: "o",
            data: ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"],
          })
        : args.includes("org.freedesktop.systemd1.Unit")
          ? unitOutput
          : output;
    if (propertyOutput instanceof Error) {
      callback(createExecFileError(propertyOutput.message), "", propertyOutput.message);
      return;
    }
    callback(null, propertyOutput, "");
  });
}

function mockSystemdManagerSnapshot(snapshot: SystemdManagerSnapshotFixture): void {
  mockSystemdManagerProperties(
    buildSystemdManagerPropertyOutput(snapshot),
    buildSystemdUnitPropertyOutput(snapshot),
  );
}

const assertRestartSuccess = async (env: NodeJS.ProcessEnv) => {
  const { write, stdout } = createWritableStreamMock();
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
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("systemd availability", () => {
  it.each([
    { socket: "bus", runtime: "/run/user/1000", sessionAddress: "unix:path=/tmp/dbus-stale" },
    { socket: "systemd/private", runtime: undefined, sessionAddress: "unix:path=/tmp/dbus-stale" },
  ])(
    "uses runtime $socket despite session address $sessionAddress",
    async ({ socket, runtime, sessionAddress }) => {
      versionFixture.useScenarioResponse = true;
      const uid = socket === "bus" ? 1000 : 1002;
      const runtimeDir = `/run/user/${uid}`;
      mockEffectiveUid(uid);
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      existsSyncMock.mockImplementation((file) => file === `${runtimeDir}/${socket}`);
      vi.spyOn(
        await import("./systemd-peer-native.js"),
        "openSystemdUserManager",
      ).mockResolvedValue({
        query: async (args) => {
          expect(args.at(-1)).toBe("Version");
          return ["252.39"];
        },
        close: async () => {},
        verify: () => {},
      });
      execFileMock.mockImplementation((_cmd, args, opts, cb) => {
        if (args.includes("Version")) {
          expect(args).toContain("--auto-start=no");
          if (
            socket === "bus" &&
            opts.env?.DBUS_SESSION_BUS_ADDRESS === `unix:path=${runtimeDir}/bus`
          ) {
            cb(null, 's "252.39"', "");
          } else {
            cb(createExecFileError("Failed to connect to bus"), "", "Failed to connect to bus");
          }
          return;
        }
        assertUserSystemctlArgs(args, "status");
        if (!opts.env) {
          throw new Error("expected systemctl env");
        }
        expect(opts.env.XDG_RUNTIME_DIR).toBe(socket === "bus" ? undefined : runtimeDir);
        expect(opts.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${runtimeDir}/${socket}`);
        cb(null, "", "");
      });

      await expect(
        isSystemdUserServiceAvailable({
          USER: "debian",
          XDG_RUNTIME_DIR: runtime === undefined ? undefined : runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: sessionAddress,
        }),
      ).resolves.toBe(true);
    },
  );

  it("does not fall back to machine scope when --user fails with permission denied", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "status"]);
      cb(
        createExecFileError("Failed to connect to bus: Permission denied", {
          stderr: "Failed to connect to bus: Permission denied",
          code: 1,
        }),
        "",
        "",
      );
    });
    // Only one call should be made: no machine-scope fallback for permission denied errors.
    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("isSystemdServiceEnabled", () => {
  it.each(["access-denied", "missing-file", "manager-denied", "not-found"] as const)(
    "distinguishes absence from failed enablement inspection: %s",
    async (scenario) => {
      let env: NodeJS.ProcessEnv = { HOME: TEST_MANAGED_HOME };
      if (scenario === "missing-file") {
        vi.spyOn(fs, "access").mockRejectedValueOnce(
          Object.assign(new Error("missing unit"), { code: "ENOENT" }),
        );
      } else {
        vi.spyOn(fs, "access").mockResolvedValue(undefined);
      }
      if (scenario === "access-denied") {
        execFileMock.mockImplementation(
          execFileResult(createExecFileError("spawn systemctl EACCES", { code: "EACCES" }), "", ""),
        );
      } else if (scenario === "manager-denied") {
        env = { ...env, ...mockMachineManager("debian") };
        const probe = expectDefined(execFileMock.getMockImplementation(), "manager fixture");
        execFileMock.mockImplementation((command, args, options, done) => {
          if (args.includes("Version")) {
            probe(command, args, options, done);
            return;
          }
          assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
          done(createExecFileError("permission denied"), "", "permission denied");
        });
      } else if (scenario === "not-found") {
        env = { ...env, OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: " custom-unit.service " };
        execFileMock.mockImplementationOnce(
          systemctlUserResult(
            [
              createExecFileError(
                "Command failed: systemctl --user is-enabled custom-unit.service",
                { code: 4 },
              ),
              "not-found\n",
              "",
            ],
            "is-enabled",
            "custom-unit.service",
          ),
        );
      }
      const result = isSystemdServiceEnabled({ env });
      if (scenario === "access-denied") {
        await expect(result).rejects.toMatchObject({ reason: "service-manager-access-denied" });
      } else if (scenario === "manager-denied") {
        await expect(result).rejects.toThrow("systemctl is-enabled unavailable: permission denied");
      } else {
        await expect(result).resolves.toBe(false);
        if (scenario === "missing-file") {
          expect(execFileMock).not.toHaveBeenCalled();
        } else {
          expect(fs.access).toHaveBeenCalledWith(
            `${TEST_MANAGED_HOME}/.config/systemd/user/custom-unit.service`,
          );
        }
      }
    },
  );
});

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
    // An intentional separate gateway (e.g. a rescue bot) under a different
    // unit name must NOT be classified as a duplicate of the canonical user
    // unit, or doctor could remove a legitimate user gateway (issue #79375 P1).
    mockUnitFileLayout({ user: true, system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-rescue.service",
        detail: "unit: /etc/systemd/system/openclaw-rescue.service",
        sourcePath: "/etc/systemd/system/openclaw-rescue.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
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
          unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/openclaw-gateway.service`,
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
    // The unguarded startup path must not hand out a destructive command.
    expect(warning).not.toContain("rm ");
    expect(warning).not.toContain("disable --now");
  });

  it("does not adopt a system Gateway while inspecting the node service", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValue([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        sourcePath: "/etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    await expect(
      findInstalledSystemdGatewayScope({
        HOME: TEST_MANAGED_HOME,
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
      }),
    ).resolves.toBeNull();
  });

  it("isSystemdServiceEnabled queries the marker-owned custom system unit name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        sourcePath: "/etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", "openclaw.service"]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it.each([false, true])("restarts system-scope units only as root (root=%s)", async (root) => {
    mockUnitFileLayout({ system: root ? "/etc/systemd/system/openclaw-gateway.service" : false });
    if (!root) {
      findSystemGatewayServicesMock.mockResolvedValueOnce([
        {
          platform: "linux",
          label: "openclaw.service",
          detail: "unit: /etc/systemd/system/openclaw.service",
          sourcePath: "/etc/systemd/system/openclaw.service",
          scope: "system",
          marker: "openclaw",
        },
      ]);
    }
    mockEffectiveUid(root ? 0 : 1000);
    if (root) {
      for (const action of ["reset-failed", "restart"]) {
        execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual([action, GATEWAY_SERVICE]);
          cb(null, "", "");
        });
      }
    }
    const { stdout, write } = createWritableStreamMock();
    const operation = restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } });
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

  it("readSystemdServiceRuntime queries the system manager for system-scope units", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args[0]).toBe("show");
      expect(args).not.toContain("--user");
      cb(
        null,
        [
          "Id=openclaw-gateway.service",
          "LoadState=loaded",
          "ActiveState=active",
          "SubState=running",
          "MainPID=4242",
        ].join("\n"),
        "",
      );
    });
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(4242);
    expect(runtime.systemd?.unit).toBe("openclaw-gateway.service");
    expect(runtime.systemd?.scope).toBe("system");
  });
});

describe("readSystemdServiceRuntime", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  });

  async function readRuntimeFromShowOutput(output: string) {
    execFileMock.mockReset();
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args[0]).toBe("--user");
        expect(args[1]).toBe("show");
        cb(null, `LoadState=loaded\n${output}`, "");
      });
    return await readSystemdServiceRuntime(
      { HOME: TEST_MANAGED_HOME },
      { commandInspection: { kind: "present" } },
    );
  }

  it.each([
    {
      name: "activating/auto-restart is not stopped",
      output: "ActiveState=activating\nSubState=auto-restart\nMainPID=0",
      expected: { status: "unknown", state: "activating", subState: "auto-restart" },
    },
    {
      name: "crash-loop give-up retains Result and restart counters",
      output:
        "ActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=5\nStartLimitBurst=5\nMainPID=0\nExecMainStatus=1\nExecMainCode=exited",
      expected: {
        status: "stopped",
        state: "failed",
        subState: "failed",
        lastExitStatus: 1,
        lastExitReason: "exited",
        systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
      },
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
      execFileMock.mockReset().mockImplementationOnce(systemctlUserSuccess("status"));
      const runtime = await readSystemdServiceRuntime(
        { HOME: TEST_MANAGED_HOME },
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
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const detail = "Permission denied while reading systemd state";
        cb(createExecFileError(detail, { stderr: detail }), "", detail);
      });

    await expect(
      readSystemdServiceRuntime(
        { HOME: TEST_MANAGED_HOME },
        { commandInspection: { kind: "present" } },
      ),
    ).resolves.toEqual({
      status: "unknown",
      detail: "Permission denied while reading systemd state",
      missingUnit: false,
    });
  });

  it("does not call an installed unit missing when systemd reports not-found", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (target !== "/etc/systemd/system/openclaw-gateway.service") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    });
    execFileMock.mockImplementationOnce(
      execFileResult(null, "LoadState=not-found\nActiveState=inactive\nSubState=dead", ""),
    );
    await expect(
      readSystemdServiceRuntime(
        { HOME: TEST_MANAGED_HOME },
        { commandInspection: { kind: "present" } },
      ),
    ).resolves.toMatchObject({
      status: "unknown",
      missingUnit: false,
    });
  });

  it("surfaces systemd cgroup metrics and KillMode", async () => {
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(
        systemctlUserResult(
          [
            null,
            [
              "Id=openclaw-gateway.service",
              "LoadState=loaded",
              "ActiveState=active",
              "SubState=running",
              "MainPID=1234",
              "ExecMainStatus=0",
              "ExecMainCode=running",
              "KillMode=process",
              "TasksCurrent=807",
              "MemoryCurrent=11918534246",
            ].join("\n"),
            "",
          ],
          "show",
          GATEWAY_SERVICE,
          "--no-page",
          "--property",
          "Id,LoadState,UnitFileState,RefuseManualStart,CanStart,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent,ControlGroup",
        ),
      );
    const runtime = await readSystemdServiceRuntime(
      { HOME: TEST_MANAGED_HOME },
      { timeoutMs: 1234, commandInspection: { kind: "present" } },
    );
    for (const call of execFileMock.mock.calls) {
      const options = call[2];
      expect(options.killSignal).toBe("SIGKILL");
    }
    expect(runtime).toEqual({
      status: "running",
      state: "active",
      subState: "running",
      pid: 1234,
      lastExitStatus: 0,
      lastExitReason: "running",
      systemd: {
        scope: "user",
        unit: "openclaw-gateway.service",
        killMode: "process",
        tasksCurrent: 807,
        memoryCurrent: 11_918_534_246,
        transport: {
          kind: "session-bus",
          address: process.env.DBUS_SESSION_BUS_ADDRESS,
          runtimeDir: process.env.XDG_RUNTIME_DIR,
        },
      },
    });
  });
});

describe("readSystemdServiceExecStart", () => {
  it.each(["none", "uid", "revoked-before", "revoked-load", "manager-change"] as const)(
    "reads a collected definition only with current recovery ownership (%s)",
    async (fault) => {
      mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
      let loaded = false;
      let owners = 0;
      const assertCurrent = vi.fn(() => {
        if (fault === "revoked-before" || (fault === "revoked-load" && loaded)) {
          throw new Error("source/executor revoked");
        }
      });
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        let output: string;
        if (args.includes("GetUnit")) {
          const detail = `Call failed: Unit ${GATEWAY_SERVICE} not loaded.`;
          callback(createExecFileError(detail), "", detail);
          return;
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
          output = buildSystemdUnitPropertyOutput({});
        } else {
          output = buildSystemdManagerPropertyOutput({
            programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          });
        }
        callback(null, output, "");
      });
      const observed = readSystemdServiceExecStart(
        { HOME: TEST_SERVICE_HOME },
        {
          requireEffective: true,
          requireLoaded: true,
          loadForInspection: { managerUid: fault === "uid" ? 2002 : 2001, assertCurrent },
        },
      );
      if (fault === "none") {
        await expect(observed).resolves.toMatchObject({
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        });
      } else {
        await expect(observed).rejects.toThrow();
      }
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

  it.each(["local", "global", "absent"] as const)(
    "loaded-only inspection does not activate or adopt an unloaded %s definition",
    async (scenario) => {
      execFileMock.mockReset();
      if (scenario === "local") {
        mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
      } else {
        vi.spyOn(fs, "readFile").mockRejectedValue(
          Object.assign(new Error("missing base"), { code: "ENOENT" }),
        );
      }
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        if (args.includes("GetUnitFileState") && scenario === "global") {
          callback(null, JSON.stringify({ type: "s", data: ["disabled"] }), "");
          return;
        }
        const message = args.includes("GetUnitFileState")
          ? `Call failed: Unit file ${GATEWAY_SERVICE} does not exist.`
          : `Call failed: Unit ${GATEWAY_SERVICE} not loaded.`;
        callback(createExecFileError(message), "", message);
      });
      const result = readSystemdServiceExecStart(
        { HOME: TEST_SERVICE_HOME },
        { requireEffective: true, requireLoaded: true },
      );
      if (scenario === "absent") {
        await expect(result).resolves.toBeNull();
      } else {
        await expect(result).rejects.toThrow("could not be inspected");
      }
      expect(
        execFileMock.mock.calls.every(
          (call) => call[1].includes("GetUnit") || call[1].includes("GetUnitFileState"),
        ),
      ).toBe(true);
      expect(execFileMock.mock.calls.some((call) => call[1].includes("GetUnitFileState"))).toBe(
        true,
      );
    },
  );

  it("strictly distinguishes a missing base unit from an unreadable existing unit", async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(createExecFileError(`Call failed: Unit ${GATEWAY_SERVICE} not found.`), "", "");
    });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("missing service"), { code: "ENOENT" }),
    );
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledWith(
      "busctl",
      expect.arrayContaining(["LoadUnit", GATEWAY_SERVICE]),
      expect.anything(),
      expect.anything(),
    );

    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("unreadable-service-secret-canary"), { code: "EACCES" }),
    );
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow(`${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`);
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
    mockSystemdManagerSnapshot({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      fragmentPath,
      dropInPaths,
      environmentFiles: [["/etc/systemd/user/gateway.env", false]],
      needDaemonReload: true,
    });

    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toEqual({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      environment: { OWNER: "global" },
      environmentValueSources: { OWNER: "file" },
      sourcePath: fragmentPath,
      definitionPaths: [fragmentPath, ...dropInPaths],
      reloadPending: true,
    });
  });

  it("accepts manager LoadState=not-found before reading service properties", async () => {
    mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
    mockSystemdManagerProperties(
      new Error("must not inspect a missing service"),
      buildSystemdUnitPropertyOutput({ fragmentPath: "", loadState: "not-found" }),
    );
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "wrong property types", output: JSON.stringify({ type: "s", data: "bad" }) },
    { name: "malformed LoadUnit", loaded: JSON.stringify({ type: "o", data: [] }) },
    { name: "empty drop-in", unit: buildSystemdUnitPropertyOutput({ dropInPaths: [""] }) },
    { name: "invalid unit", unit: buildSystemdUnitPropertyOutput({ loadState: "error" }) },
  ])("strictly rejects $name with a missing local base", async ({ output, loaded, unit }) => {
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("missing base"), { code: "ENOENT" }),
    );
    mockSystemdManagerProperties(
      output ??
        buildSystemdManagerPropertyOutput({ programArguments: ["/usr/bin/openclaw", "gateway"] }),
      unit,
    );
    if (loaded) {
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, loaded, "");
      });
    }
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();
    if (output) {
      await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toBeNull();
    }
  });

  it.each(["EACCES"])("enforces only active EnvironmentFile inputs (%s)", async (code) => {
    const inactive = `${TEST_SERVICE_HOME}/.openclaw/retired.env`;
    const active = `${TEST_SERVICE_HOME}/.openclaw/current.env`;
    const dropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/environment.conf`;
    mockReadGatewayServiceFile(
      ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", `EnvironmentFile=${inactive}`],
      {
        [inactive]: Object.assign(new Error("retired environment unavailable"), { code }),
        [active]: "ACTIVE_VALUE=current\n",
        [dropIn]: `[Service]\nEnvironmentFile=\nEnvironmentFile=${active}\n`,
      },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: [
        [active, false],
        [inactive, true],
      ],
      dropInPaths: [dropIn],
    });
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toMatchObject({
      environment: { ACTIVE_VALUE: "current" },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
      definitionPaths: [`${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`, dropIn],
      managedOverrides: { environment: { keys: ["ACTIVE_VALUE"], resetFiles: true } },
    });
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: [[inactive, false]],
    });
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow("retired environment unavailable");
  });

  it("reports one manager-effective command snapshot while retaining the managed base definition", async () => {
    const effectiveArguments = ["/opt/operator/openclaw", "gateway", "run"];
    const objectPath = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
    const managedEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/managed.env`;
    const effectiveEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "WorkingDirectory=/srv/managed-openclaw",
        "Environment=BASE_INLINE=base BASE_SHARED=inline",
        `EnvironmentFile=${managedEnvironmentFile}`,
      ],
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
    mockSystemdManagerSnapshot({
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
      const result = execute(...args);
      elapsed += [100, 300, 0][calls++] ?? 0;
      return result;
    });

    const command = await readSystemdServiceExecStart(
      { HOME: TEST_SERVICE_HOME },
      { timeoutMs: 1200, requireEffective: true, requireLoaded: true },
    );

    expect(command).toMatchObject({
      programArguments: effectiveArguments,
      workingDirectory: "/srv/operator-openclaw",
      environment: {
        INLINE: "inline",
        SHARED: "file",
        FILE_ONLY: "file",
        KEEP_EXACT: "actual",
      },
      environmentValueSources: {
        INLINE: "inline",
        SHARED: "inline-and-file",
        FILE_ONLY: "file",
        KEEP_EXACT: "file",
      },
      managedDefinition: {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/srv/managed-openclaw",
        environment: { BASE_INLINE: "base", BASE_SHARED: "file", BASE_FILE: "base" },
        environmentValueSources: {
          BASE_INLINE: "inline",
          BASE_SHARED: "inline-and-file",
          BASE_FILE: "file",
        },
      },
      managedOverrides: {
        launcher: "command",
        environment: {
          keys: ["INLINE", "SHARED", "REMOVE_NAME", "REMOVE_EXACT", "FILE_ONLY", "KEEP_EXACT"],
          resetInline: true,
          resetFiles: true,
        },
      },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
    });
    expect(execFileMock.mock.calls.map((call) => call[2].timeout)).toEqual([400, 550, 800]);
    expect(execFileMock.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
    for (const [commandName, , options] of execFileMock.mock.calls) {
      expect(commandName).toBe("busctl");
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(1234);
      expect(options.killSignal).toBe("SIGKILL");
    }
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      "--user",
      "--json=short",
      "--auto-start=no",
      "get-property",
      "org.freedesktop.systemd1",
      objectPath,
      "org.freedesktop.systemd1.Unit",
      "FragmentPath",
      "DropInPaths",
      "NeedDaemonReload",
      "LoadState",
      "UnitFileState",
      "ActiveState",
      "CanStart",
      "RefuseManualStart",
    ]);
  });

  it("reads a drop-in-only ExecStart while the managed base remains the ownership anchor", async () => {
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    mockReadGatewayServiceFile(
      ["[Service]", "WorkingDirectory=/srv/managed-openclaw", "Environment=MANAGED_VALUE=base"],
      { [dropInPath]: "[Service]\nExecStart=/opt/operator/openclaw gateway run" },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      workingDirectory: "/srv/operator-openclaw",
      environment: ["OPERATOR_VALUE=effective"],
      dropInPaths: [dropInPath],
    });

    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      managedDefinition: { programArguments: [], environment: { MANAGED_VALUE: "base" } },
      managedOverrides: { launcher: "command" },
    });

    mockSystemdManagerProperties(new Error("systemd manager unavailable"));
    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toBeNull();
  });

  it.each([false, true])("reports pending manager reload only when it is %s", async (pending) => {
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    const readFile = mockReadGatewayServiceFile(
      ["[Service]", "ExecStart=/usr/bin/openclaw gateway run"],
      { [dropInPath]: "[Service]\nWorkingDirectory=/srv/operator-openclaw" },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      workingDirectory: "/srv/operator-openclaw",
      dropInPaths: [dropInPath],
      needDaemonReload: pending,
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command?.reloadPending).toBe(pending || undefined);
    expect(command?.managedOverrides).toEqual(
      pending ? { launcher: "command", environment: true } : { launcher: "working-directory" },
    );
    expect(readFile).toHaveBeenCalledTimes(pending ? 1 : 2);
  });

  it("retains loaded drop-in ownership after a backslash comment even when values equal the base", async () => {
    const comment = "# operator note \\";
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "WorkingDirectory=/srv/openclaw",
        "Environment=OPENCLAW_GATEWAY_TOKEN=shared NODE_COMPILE_CACHE=/tmp/cache",
      ],
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
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      workingDirectory: "/srv/openclaw",
      environment: ["OPENCLAW_GATEWAY_TOKEN=shared", "NODE_COMPILE_CACHE=/tmp/cache"],
      dropInPaths: [dropInPath],
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command).toMatchObject({
      managedDefinition: { environment: { OPENCLAW_GATEWAY_TOKEN: "shared" } },
      managedOverrides: {
        launcher: "command",
        environment: { keys: ["OPENCLAW_GATEWAY_TOKEN", "NODE_COMPILE_CACHE"] },
      },
    });
  });

  it("preserves managed removals while clearing superseded drop-in ownership in directive order", async () => {
    const firstDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/10-file.conf`;
    const resetDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/20-reset.conf`;
    const operatorEnv = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "Environment=FOO=base BAR=base",
        "UnsetEnvironment=BAR",
      ],
      {
        [firstDropIn]: `[Service]\nEnvironmentFile=${operatorEnv}\n`,
        [resetDropIn]: "[Service]\nEnvironmentFile=\nUnsetEnvironment=FOO\nUnsetEnvironment=\n",
        [operatorEnv]: "FOO=operator\n",
      },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: ["FOO=base", "BAR=base"],
      dropInPaths: [firstDropIn, resetDropIn],
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command).toMatchObject({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: { FOO: "base", BAR: "base" },
      environmentValueSources: { FOO: "inline", BAR: "inline" },
      managedDefinition: { environment: { FOO: "base" } },
      managedOverrides: { environment: { keys: ["BAR"], resetFiles: true } },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
    });
  });

  it.each([
    {
      name: "pending reload state",
      properties: buildSystemdUnitPropertyOutput({}).replace(
        JSON.stringify({ type: "b", data: false }),
        JSON.stringify({ type: "b", data: "false" }),
      ),
    },
  ])(
    "falls back to the coherent managed snapshot when $name is malformed",
    async ({ properties }) => {
      mockReadGatewayServiceFile([
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "WorkingDirectory=/srv/managed-openclaw",
        "Environment=MANAGED_VALUE=base",
      ]);
      mockSystemdManagerProperties(
        buildSystemdManagerPropertyOutput({
          programArguments: ["/opt/operator/openclaw", "gateway", "run"],
          environment: ["OPERATOR_VALUE=effective"],
        }),
        properties,
      );

      await expect(
        readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
      ).rejects.toThrow();
      expect(execFileMock.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(Math.floor(5_000 / 3));
      for (const [command, , options] of execFileMock.mock.calls) {
        expect(command).toBe("busctl");
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(5_000);
        expect(options.killSignal).toBe("SIGKILL");
      }
      await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject(
        {
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/srv/managed-openclaw",
          environment: { MANAGED_VALUE: "base" },
          environmentValueSources: { MANAGED_VALUE: "inline" },
          managedDefinition: {
            programArguments: ["/usr/bin/openclaw", "gateway", "run"],
            workingDirectory: "/srv/managed-openclaw",
            environment: { MANAGED_VALUE: "base" },
            environmentValueSources: { MANAGED_VALUE: "inline" },
          },
          managedOverrides: { launcher: "command", environment: true },
        },
      );
    },
  );

  it("applies managed directive resets before ordered environment assignments and removals", async () => {
    const staleFile = `${TEST_SERVICE_HOME}/.openclaw/stale.env`;
    const readFileSpy = mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
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
      ],
      {
        [staleFile]: "STALE_FILE=discarded\n",
        [`${TEST_SERVICE_HOME}/.openclaw/first.env`]: "FILE_ONLY=overridden\n",
        [`${TEST_SERVICE_HOME}/.openclaw/.env`]: [
          "INLINE_FILE=file",
          "FILE_ONLY=from-file",
          "REMOVE_NAME=file",
          "REMOVE_EXACT=final value",
          "KEEP_MISMATCH=file",
        ].join("\n"),
        [`${TEST_SERVICE_HOME}/.openclaw/second env.env`]: [
          "# comment",
          "; another comment",
          'SYMBOLS="symbol \\" \\\\ \\$ \\`"',
          'MIXED_API_KEY="55\\"55" "FIVE" cinco',
          'UNQUOTED_QUOTES_API_KEY=foo"bar"',
        ].join("\n"),
      },
    );
    mockSystemdManagerProperties(new Error("systemd manager unavailable"));

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command?.environment).toEqual({
      PLAIN: "first",
      QUOTED: "value with spaces",
      CONTINUED: "second-line",
      REPEATED: "last value",
      INLINE_FILE: "file",
      FILE_ONLY: "from-file",
      KEEP_MISMATCH: "file",
      SYMBOLS: 'symbol " \\ $ `',
      MIXED_API_KEY: '55"55FIVEcinco',
      UNQUOTED_QUOTES_API_KEY: 'foo"bar"',
    });
    expect(command?.environmentValueSources).toEqual({
      PLAIN: "inline",
      QUOTED: "inline",
      CONTINUED: "inline",
      REPEATED: "inline",
      INLINE_FILE: "inline-and-file",
      FILE_ONLY: "file",
      KEEP_MISMATCH: "inline-and-file",
      SYMBOLS: "file",
      MIXED_API_KEY: "file",
      UNQUOTED_QUOTES_API_KEY: "file",
    });
    expect(readFileSpy).not.toHaveBeenCalledWith(staleFile, "utf8");
  });
});

describe("stageSystemdService", () => {
  function mockSystemctlStatusOk(): void {
    execFileMock.mockImplementationOnce(systemctlUserSuccess("status"));
  }

  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (env) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-gateway-work"}.service not found.`,
    }));
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });

  it("removes legacy gateway version metadata after a backslash comment without restarting", async () => {
    const comment = "# operator note \\";
    const { env, unitPath } = await createSystemdFixture("gateway");
    await writeUnitFixture(
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
    execFileMock.mockImplementationOnce(systemctlUserSuccess("daemon-reload"));

    await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(true);

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unit).toContain("Description=OpenClaw Gateway\n");
    expect(unit.split("\n")).toContain("ExecStart=/usr/bin/openclaw gateway run");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(unit).toContain('Environment="OTHER_SETTING=kept value %h/%%h"');
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    for (const [, timeoutMs] of assertNoSystemSystemdOwnershipMock.mock.calls) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(5_000);
    }
    expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
      killSignal: "SIGKILL",
      timeout: expect.any(Number),
    });
  });

  it.each([
    { name: "mismatched version", version: "2026.7.1-1", reset: false, admitted: undefined },
    { name: "reset managed markers", version: "2026.7.1-2", reset: true, admitted: undefined },
    {
      name: "ownership refused before publication",
      version: "2026.7.1-2",
      reset: false,
      admitted: 0,
    },
    {
      name: "ownership refused after publication",
      version: "2026.7.1-2",
      reset: false,
      admitted: 2,
    },
  ])("preserves legacy metadata: $name", async ({ version, reset, admitted }) => {
    const { env, unitPath } = await createSystemdFixture("gateway");
    const previous = [
      "[Unit]",
      "Description=OpenClaw Gateway (v2026.7.1-2)",
      "",
      "[Service]",
      "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
      "Environment=OPENCLAW_SERVICE_KIND=gateway",
      ...(reset ? ["Environment="] : []),
      `Environment=OPENCLAW_SERVICE_VERSION=${version}`,
      "",
    ].join("\n");
    await writeUnitFixture(unitPath, previous);
    if (admitted !== undefined) {
      for (let index = 0; index < admitted; index++) {
        assertNoSystemSystemdOwnershipMock.mockResolvedValueOnce();
      }
      assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(new Error("system ownership"));
      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).rejects.toThrow(
        "system ownership",
      );
    } else {
      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(false);
      expect(assertNoSystemSystemdOwnershipMock).not.toHaveBeenCalled();
    }
    await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      checkpoint: 0,
      existing: "unit",
      error: "system scope owns openclaw-gateway-stage-test.service",
    },
    { checkpoint: 1, existing: "none", error: "system ownership appeared" },
    { checkpoint: 2, existing: "both", error: "system ownership appeared" },
    { checkpoint: 3, existing: "none", error: "system ownership appeared before activation" },
  ])(
    "preserves prior files when system ownership refuses publication at checkpoint $checkpoint",
    async ({ checkpoint, existing, error }) => {
      const { env, unitPath, envFilePath } = await createSystemdFixture("gateway");
      const previous = "[Unit]\nDescription=Previous gateway\n";
      const previousEnv = "OPENCLAW_GATEWAY_TOKEN=previous-token\n";
      if (existing !== "none") {
        await writeUnitFixture(unitPath, previous, existing === "both" ? 0o400 : 0o644);
      }
      if (existing === "both") {
        await fs.writeFile(envFilePath, previousEnv, { encoding: "utf8", mode: 0o400 });
        await Promise.all([fs.chmod(unitPath, 0o400), fs.chmod(envFilePath, 0o400)]);
      }
      mockSystemctlStatusOk();
      for (let index = 0; index < checkpoint; index++) {
        assertNoSystemSystemdOwnershipMock.mockResolvedValueOnce();
      }
      if (checkpoint === 3) {
        assertNoSystemSystemdOwnershipMock.mockRejectedValue(new Error(error));
      } else {
        assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(new Error(error));
      }
      const fixture =
        checkpoint === 0 || checkpoint === 3
          ? gatewayPortSystemdServiceFixture(env, "18789")
          : gatewaySystemdServiceFixture(env, {
              environment: { OPENCLAW_GATEWAY_PORT: "18789", OPENCLAW_GATEWAY_TOKEN: "new-token" },
              environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
            });
      await expect(
        (checkpoint === 3 ? installSystemdService : stageSystemdService)(fixture),
      ).rejects.toThrow(error);
      if (existing === "none") {
        await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      }
      if (existing === "both") {
        for (const file of [unitPath, envFilePath]) {
          expect((await fs.stat(file)).mode & 0o777).toBe(0o400);
        }
        await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe(previousEnv);
      } else if (checkpoint < 2) {
        await expect(fs.access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (checkpoint === 0) {
        await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledWith(
          "openclaw-gateway-stage-test.service",
        );
      }
      if (checkpoint === 3) {
        expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledTimes(5);
        expect(execFileMock).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("round-trips file-managed secrets through parse, repair planning, and emit", async () => {
    const { env, unitPath, envFilePath, stateDir } = await createSystemdFixture("gateway");
    const wrapperPath = path.join(stateDir, "openclaw-wrapper");
    const fileBackedOpenAiKey = "file-backed-openai-test-key";
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.chmod(wrapperPath, 0o755);
    await fs.writeFile(envFilePath, `OPENAI_API_KEY=${fileBackedOpenAiKey}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeUnitFixture(
      unitPath,
      [
        "[Service]",
        `ExecStart=${wrapperPath} gateway --port 18789`,
        `EnvironmentFile=-${envFilePath}`,
        "Environment=HOME=" + env.HOME,
        "Environment=OPENCLAW_GATEWAY_PORT=18789",
        "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY",
      ].join("\n"),
    );

    const command = await readSystemdServiceExecStart(env);
    expect(command?.environment?.OPENAI_API_KEY).toBe(fileBackedOpenAiKey);
    expect(command?.environmentValueSources?.OPENAI_API_KEY).toBe("file");
    expect(command?.environmentValueSources?.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("inline");

    const plan = await buildGatewayInstallPlan({
      env: { ...env, PATH: "/usr/bin:/bin" },
      port: 18_789,
      runtime: "node",
      platform: "linux",
      runtimePath: process.execPath,
      wrapperPath,
      existingEnvironment: command?.environment,
      existingEnvironmentValueSources: command?.environmentValueSources,
      authStore: { version: 1, profiles: {} },
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      },
    });
    expect(plan.environmentValueSources?.OPENAI_API_KEY).toBe("file");
    expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OPENAI_API_KEY");

    mockSystemctlStatusOk();
    await stageSystemdService({
      env,
      stdout: createWritableStreamMock().stdout,
      ...plan,
    });

    const [rewrittenUnit, rewrittenEnvFile] = await Promise.all([
      fs.readFile(unitPath, "utf8"),
      fs.readFile(envFilePath, "utf8"),
    ]);
    expect(rewrittenUnit).toContain(`EnvironmentFile=-${envFilePath}`);
    expect(rewrittenUnit).toContain("Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY");
    expect(rewrittenUnit).not.toContain(fileBackedOpenAiKey);
    expect(rewrittenEnvFile).toBe(`OPENAI_API_KEY=${fileBackedOpenAiKey}\n`);
  });

  it("matches differently-cased source metadata when writing node file-backed values", async () => {
    const { env, stateDir, unitPath, envFilePath, nodeEnvFilePath } =
      await createSystemdFixture("gateway");
    await fs.rm(stateDir, { recursive: true, force: true });
    const gatewayPassword = 'symbol " \\ $ `'; // pragma: allowlist secret

    mockSystemctlStatusOk();

    await stageSystemdService({
      env,
      stdout: createWritableStreamMock().stdout,
      programArguments: ["/usr/bin/openclaw", "node", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "file-backed-token",
        OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_PASSWORD,OPENCLAW_GATEWAY_TOKEN", // pragma: allowlist secret
        OPENCLAW_SERVICE_KIND: "node",
      },
      environmentValueSources: {
        openclaw_gateway_token: "file",
        openclaw_gateway_password: "file", // pragma: allowlist secret
        openclaw_service_managed_env_keys: "inline",
      },
    });

    const [unit, envFile, envFileStat] = await Promise.all([
      fs.readFile(unitPath, "utf8"),
      fs.readFile(nodeEnvFilePath, "utf8"),
      fs.stat(nodeEnvFilePath),
    ]);

    expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
    expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=file-backed-token");
    expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_PASSWORD=");
    expect(envFile).toBe(
      'OPENCLAW_GATEWAY_TOKEN=file-backed-token\nOPENCLAW_GATEWAY_PASSWORD="symbol \\" \\\\ \\$ \\`"\n',
    );
    expect(envFileStat.mode & 0o777).toBe(0o600);
    await expect(readSystemdServiceExecStart(env)).resolves.toMatchObject({
      environment: {
        OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
      },
    });
    await expect(fs.access(envFilePath)).rejects.toThrow();
  });

  it.each([false, true])(
    "preserves the gateway environment while updating node-managed values (clear=%s)",
    async (clear) => {
      const { env, unitPath, envFilePath, nodeEnvFilePath } = await createSystemdFixture("gateway");
      const legacyGatewayEnvFile = clear
        ? "OPENCLAW_GATEWAY_TOKEN=stale-token\n"
        : "OPENCLAW_GATEWAY_TOKEN=legacy-node-token\nOPENROUTER_API_KEY=operator-key\n";
      await fs.writeFile(envFilePath, legacyGatewayEnvFile, { encoding: "utf8", mode: 0o600 });
      if (clear) {
        await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-node-token\n", {
          encoding: "utf8",
          mode: 0o600,
        });
      }
      mockSystemctlStatusOk();
      await stageSystemdService(
        nodeSystemdServiceFixture(env, {
          environment: {
            ...(!clear ? { OPENCLAW_GATEWAY_TOKEN: "fresh-file-token" } : {}),
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_SERVICE_KIND: "node",
          },
          environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
        }),
      );
      const unit = await fs.readFile(unitPath, "utf8");
      if (clear) {
        expect(unit).not.toContain("EnvironmentFile=");
        await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe("");
      } else {
        expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
        expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN=fresh-file-token");
        await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(
          "OPENROUTER_API_KEY=operator-key\nOPENCLAW_GATEWAY_TOKEN=fresh-file-token\n",
        );
      }
      await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe(legacyGatewayEnvFile);
    },
  );

  it("protects tokenless gateway units and backups from legacy credentials", async () => {
    const { env, unitPath } = await createSystemdFixture("gateway");
    await writeUnitFixture(
      unitPath,
      [
        "[Service]",
        "# operator note \\",
        "ExecStart=/opt/operator/openclaw gateway run --operator-flag",
        "# operator note \\",
        "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept \\",
        "  # legacy installer note",
        "  OPENCLAW_GATEWAY_PASSWORD=legacy-password",
        "Environment=FOO=bar OPENCLAW_GATEWAY_TOKEN=inline-token BAZ=qux",
        "Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line",
        "Environment='OPENCLAW_GATEWAY_TOKEN=single-quoted-token' FROM_SINGLE=kept",
        "Environment=",
        "Environment=FILE_ONLY_SECRET=old-file-value",
        "RestartSec=17",
      ].join("\n"),
    );
    await fs.chmod(unitPath, 0o644);
    mockSystemctlStatusOk();

    await stageSystemdService(
      gatewaySystemdServiceFixture(env, {
        environment: { OPENCLAW_GATEWAY_PORT: "18789", FILE_ONLY_SECRET: "fresh-file-value" },
        environmentValueSources: { FILE_ONLY_SECRET: "file" },
      }),
    );

    const [unit, backup, unitStat, backupStat] = await Promise.all([
      fs.readFile(unitPath, "utf8"),
      fs.readFile(`${unitPath}.bak`, "utf8"),
      fs.stat(unitPath),
      fs.stat(`${unitPath}.bak`),
    ]);
    expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(unit).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(backup).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(backup).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(backup).toContain("CUSTOM_SETTING=kept");
    expect(backup.split("\n")).toContain(
      "ExecStart=/opt/operator/openclaw gateway run --operator-flag",
    );
    expect(backup).toContain("Environment=FOO=bar BAZ=qux");
    expect(backup).toContain("Environment=FROM_SINGLE=kept\nEnvironment=\n");
    expect(backup).not.toContain("FILE_ONLY_SECRET");
    expect(unit).not.toContain("fresh-file-value");
    expect(backup).toContain("RestartSec=17");
    expect(unitStat.mode & 0o777).toBe(0o600);
    expect(backupStat.mode & 0o777).toBe(0o600);
  });

  it("restores an orphan backup when later staging fails", async () => {
    const { env, unitPath } = await createSystemdFixture("gateway");
    const backupPath = `${unitPath}.bak`;
    const previous =
      "[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept\n";
    await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(backupPath, previous, { encoding: "utf8", mode: 0o640 });
    await fs.chmod(backupPath, 0o640);
    mockSystemctlStatusOk();

    await expect(
      stageSystemdService(
        gatewaySystemdServiceFixture(env, {
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_GATEWAY_TOKEN: "invalid\nmultiline",
          },
          environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
        }),
      ),
    ).rejects.toThrow("systemd EnvironmentFile values must be single-line");

    const restored = await fs.stat(backupPath);
    expect(restored.mode & 0o777).toBe(0o640);
    await expect(fs.readFile(backupPath, "utf8")).resolves.toBe(previous);
    await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears stale inline-managed keys from env file on re-stage (#76860)", async () => {
    const { env, stateDir, unitPath, envFilePath } = await createSystemdFixture("gateway");
    await writeUnitFixture(
      unitPath,
      "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=STALE_MANAGED_KEY\n",
    );
    // Existing env file carries a stale OPENCLAW_GATEWAY_TOKEN that the
    // operator previously wrote there but staging now supplies inline.
    await fs.writeFile(
      envFilePath,
      [
        "OPENCLAW_GATEWAY_TOKEN=stale-gateway-token",
        "OPENROUTER_API_KEY=or-operator-key",
        "NODE_OPTIONS=--require=/tmp/stale-preload.cjs",
        "STALE_MANAGED_KEY=stale-managed",
      ].join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );

    await fs.writeFile(
      path.join(stateDir, ".env"),
      "LLM_API_KEY=dotenv-key\nOPENCLAW_GATEWAY_TOKEN=stale-token\ntoString=dotenv-string\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    mockSystemctlStatusOk();

    await stageSystemdService({
      env,
      stdout: createWritableStreamMock().stdout,
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      // Staging manages OPENCLAW_GATEWAY_TOKEN inline; OPENCLAW_SERVICE_MANAGED_ENV_KEYS
      // marks it as an OpenClaw-managed key so the stale env-file copy is cleared.
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
    // Stale inline-managed key must be removed from the env file so the
    // fresh inline Environment= value wins (EnvironmentFile would override it).
    expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(envFile).not.toContain("NODE_OPTIONS");
    expect(envFile).not.toContain("STALE_MANAGED_KEY");
    expect(unit).toContain("Environment=NODE_OPTIONS=\n");
    // Operator-added key not managed inline must survive.
    expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    expect(envFile).not.toContain("LLM_API_KEY");
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-gateway-token");
    expect(unit).toContain("Environment=constructor=inline-constructor");
    expect(unit).not.toContain("Environment=toString=dotenv-string");
    expect(unit).not.toContain("Environment=OPENROUTER_API_KEY=or-operator-key");
    expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
  });

  it("keeps an operator secret that merely shares a name absent from state-dir .env (#88274)", async () => {
    const { env, stateDir, unitPath, envFilePath } = await createSystemdFixture("gateway");
    // Operator-managed env file holds two secrets; neither is in state-dir .env.
    await fs.writeFile(
      envFilePath,
      [
        "ANTHROPIC_API_KEY=sk-ant-operator-secret",
        "OPENROUTER_API_KEY=or-operator-key",
        "LOWERCASE_LITERAL_API_KEY=$ecret123",
        "LLM_API_KEY=$SECRET_FROM_SHELL",
        "STALE_ABSENT_KEY=$SECRET_FROM_SHELL",
        "UNRESOLVED_INLINE_KEY=$SECRET_FROM_SHELL",
        "ESCAPED_LITERAL_API_KEY=\\$SECRET_FROM_SHELL",
        "SINGLE_QUOTED_LITERAL_API_KEY='$SECRET_FROM_SHELL'",
        'DOUBLE_QUOTED_LITERAL_API_KEY="$SECRET_FROM_SHELL"',
        'MIXED_API_KEY="foo"bar',
      ].join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );

    // State-dir .env only skips an unrelated key (LLM_API_KEY). Operator keys must
    // not be treated as stale just because they are absent from the staged env.
    await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=${UNRESOLVED}\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    mockSystemctlStatusOk();

    await stageSystemdService(
      gatewaySystemdServiceFixture(env, {
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          UNRESOLVED_INLINE_KEY: "$SECRET_FROM_SHELL",
        },
        environmentValueSources: { UNRESOLVED_INLINE_KEY: "inline-and-file" },
      }),
    );

    const envFile = await fs.readFile(envFilePath, "utf8");
    expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
    expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    expect(envFile).toContain('LOWERCASE_LITERAL_API_KEY="\\$ecret123"');
    expect(envFile).not.toContain("LLM_API_KEY");
    expect(envFile).not.toContain("STALE_ABSENT_KEY");
    expect(envFile).not.toContain("UNRESOLVED_INLINE_KEY");
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("UNRESOLVED_INLINE_KEY");
    expect(envFile).toContain('ESCAPED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"');
    expect(envFile).toContain('SINGLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"');
    expect(envFile).toContain('DOUBLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"');
    expect(envFile).toContain("MIXED_API_KEY=foobar");
  });
});

describe("systemd service install and uninstall", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (env) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-gateway-work"}.service not found.`,
    }));
  });

  it("preserves disabled autostart when installing a node unit", async () => {
    const { env, unitPath } = await createSystemdFixture("node");
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserSuccess("daemon-reload"));
    execFileMock.mockImplementationOnce(systemctlUserSuccess("restart", NODE_SERVICE));

    await installSystemdService(
      nodeSystemdServiceFixture(env, {
        preserveAutoStart: true,
        description: "OpenClaw Node Host",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      }),
    );

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unitPath).toMatch(/openclaw-node\.service$/);
    expect(unit).toContain("Description=OpenClaw Node Host");
    expect(unit).toContain("openclaw node run");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "an equal-valued launcher override",
      directive: "ExecStart=/usr/bin/openclaw node run",
      shouldWarn: true,
    },
    {
      name: "an environment-only override",
      directive: "Environment=NODE_COMPILE_CACHE=/tmp/cache",
      shouldWarn: false,
    },
  ])(
    "warns after installation only when $name controls the effective launcher",
    async ({ directive, shouldWarn }) => {
      const { env, unitPath } = await createSystemdFixture("node");
      const dropInPath = path.join(`${unitPath}.d`, "operator.conf");
      await fs.mkdir(path.dirname(dropInPath), { recursive: true, mode: 0o755 });
      await fs.writeFile(dropInPath, `[Service]\n${directive}\n`, { mode: 0o644 });
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n", {
        mode: 0o644,
      });
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: ["OPENCLAW_SYSTEMD_UNIT=openclaw-node"],
        fragmentPath: unitPath,
        dropInPaths: [dropInPath],
      });
      const managerQuery = execFileMock.getMockImplementation();
      execFileMock.mockImplementation((command, args, options, callback) => {
        if (command === "systemctl") {
          callback(null, args.includes("is-enabled") ? "enabled\n" : "", "");
          return;
        }
        managerQuery?.(command, args, options, callback);
      });
      const warn = vi.fn();

      await installSystemdService(
        nodeSystemdServiceFixture(env, {
          warn,
          environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" },
        }),
      );

      if (shouldWarn) {
        expect(warn).toHaveBeenCalledWith(
          "Systemd drop-in overrides the managed service command or working directory; inspect, update, or remove the drop-in because reinstalling the base unit does not change the effective launcher.",
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    const { env } = await createSystemdFixture("node");
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
      .mockImplementationOnce(
        systemctlUserResult(
          [
            createExecFileError("enable failed"),
            "",
            "Unit file openclaw-node.service does not exist.",
          ],
          "enable",
          NODE_SERVICE,
        ),
      )
      .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
      .mockImplementationOnce(systemctlUserSuccess("enable", NODE_SERVICE))
      .mockImplementationOnce(systemctlUserSuccess("restart", NODE_SERVICE));

    await installSystemdService(
      nodeSystemdServiceFixture(env, {
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      }),
    );

    expect(execFileMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    { action: "enable", termination: "timeout" },
    { action: "restart", termination: "signal" },
  ] as const)(
    "does not retry an interrupted $action reporting a missing unit ($termination)",
    async ({ action, termination }) => {
      const { env } = await createSystemdFixture("node");
      execFileMock
        .mockImplementation(execFileSuccess())
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"));
      if (action === "restart") {
        execFileMock.mockImplementationOnce(systemctlUserSuccess("enable", NODE_SERVICE));
      }
      execFileMock.mockImplementationOnce(
        systemctlUserResult(
          [
            createExecFileError(`${action} interrupted`, { termination }),
            "",
            "Unit file openclaw-node.service does not exist.",
          ],
          action,
          NODE_SERVICE,
        ),
      );

      await expect(
        installSystemdService(
          nodeSystemdServiceFixture(env, {
            environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" },
          }),
        ),
      ).rejects.toThrow(`systemctl ${action} failed:`);
      expect(execFileMock.mock.calls.map(([, args]) => args[1])).toEqual([
        "status",
        "daemon-reload",
        ...(action === "restart" ? ["enable"] : []),
        action,
        "daemon-reload",
        "disable",
        ...(action === "restart" ? ["stop"] : []),
      ]);
    },
  );

  it("uses the sudo-u target user for discovered machine-scope install activation", async () => {
    const { env } = await createSystemdFixture("node");
    const installEnv = { ...env, ...mockMachineManager("openclaw"), SUDO_USER: "admin" };
    expect(resolveSystemdUserServiceAccount(installEnv)).toBe("openclaw");

    await installSystemdService(
      nodeSystemdServiceFixture(installEnv, {
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      }),
    );

    expect(
      execFileMock.mock.calls.map(([, args]) => (args.includes("Version") ? "Version" : args[3])),
    ).toEqual(["Version", "Version", "status", "daemon-reload", "enable", "restart"]);
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    const { env } = await createSystemdFixture("node");
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no user info");
    });
    mockNodeInstallNoMediumFailure();

    await expect(
      installSystemdService({
        env,
        stdout: createWritableStreamMock().stdout,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      }),
    ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus: No medium found");

    expect(execFileMock.mock.calls.map(([, args]) => args)).toEqual([
      ["--user", "status"],
      ["--user", "daemon-reload"],
      ["--user", "enable", NODE_SERVICE],
      ["--user", "daemon-reload"],
    ]);
  });

  it.each([
    "Failed to disable unit: Access denied.\nUnit openclaw-node.service is not active.",
    "Unit unrelated.service is not active.",
  ])("refuses to remove the unit when systemctl disable fails: %s", async (detail) => {
    const { env, unitPath, nodeEnvFilePath } = await createSystemdFixture("node");
    await writeUnitFixture(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
    await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=preserved-token\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(
        systemctlUserResult(
          [createExecFileError(detail), "", detail],
          "disable",
          "--now",
          NODE_SERVICE,
        ),
      );

    const { stdout } = createWritableStreamMock();

    await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
      `systemctl disable failed: ${detail}`,
    );
    await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
    await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toContain("preserved-token");
  });

  it.each(["Failed to stop openclaw-node.service: Unit openclaw-node.service not loaded."])(
    "keeps missing or inactive systemd unit removal idempotent: %s",
    async (detail) => {
      const { env } = await createSystemdFixture("node");
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(
          systemctlUserResult(
            [createExecFileError(detail), "", detail],
            "disable",
            "--now",
            NODE_SERVICE,
          ),
        );

      const { write, stdout } = createWritableStreamMock();

      await expect(uninstallSystemdService({ env, stdout })).resolves.toBeUndefined();
      expect(requireFirstWrite(write)).toContain("Systemd service not found");
    },
  );

  it.each(["operator-values", "password-only", "unlink-refused"] as const)(
    "uninstalls the selected node unit and cleans credentials only after removal: %s",
    async (scenario) => {
      const { env, unitPath, nodeEnvFilePath } = await createSystemdFixture("node");
      await writeUnitFixture(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
      if (scenario !== "password-only") {
        await writeUnitFixture(`${unitPath}.bak`, "[Unit]\nDescription=Previous OpenClaw Node\n");
      }
      const retained =
        [
          "OPENROUTER_API_KEY=operator-key",
          'LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
          'SINGLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
          'DOUBLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
        ].join("\n") + "\n";
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
                "SINGLE_QUOTED_LITERAL_API_KEY='$SECRET_FROM_SHELL'",
                'DOUBLE_QUOTED_LITERAL_API_KEY="$SECRET_FROM_SHELL"',
              ].join("\n") + "\n";
      await fs.writeFile(nodeEnvFilePath, previous, { encoding: "utf8", mode: 0o600 });
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", NODE_SERVICE));
      if (scenario === "unlink-refused") {
        vi.spyOn(fs, "unlink").mockRejectedValueOnce(
          Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
        );
      }
      const { write, stdout } = createWritableStreamMock();
      const operation = uninstallSystemdService({ env, stdout });
      if (scenario === "unlink-refused") {
        await expect(operation).rejects.toThrow("EACCES: permission denied");
        await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
        await expect(fs.readFile(`${unitPath}.bak`, "utf8")).resolves.toContain(
          "Previous OpenClaw Node",
        );
        await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(previous);
      } else {
        await operation;
        await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
        if (scenario === "password-only") {
          await expect(fs.access(nodeEnvFilePath)).rejects.toThrow();
        } else {
          await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(retained);
          expect(requireFirstWrite(write)).toContain("Removed systemd service");
        }
      }
      expect(execFileMock).toHaveBeenCalledTimes(2);
    },
  );
});

describe("isSystemUnitActiveAndEnabled", () => {
  it.each([
    ["user", { code: 1 }, "Failed to connect to bus: Permission denied"],
    ["system", { code: 3, termination: "timeout" }, "Command timed out"],
  ] satisfies ["user" | "system", Pick<ExecFileError, "code" | "termination">, string][])(
    "keeps failed %s activity probes distinguishable from inactivity: %j",
    async (scope, options, detail) => {
      execFileMock.mockImplementation(
        execFileResult(createExecFileError(detail, options), "", detail),
      );
      await expect(
        isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, scope),
      ).resolves.toEqual({ ok: false, error: detail });
    },
  );

  it.each([
    {
      name: "active and boot-enabled",
      active: null,
      enabled: null,
      state: "enabled",
      expected: true,
    },
    { name: "inactive", active: { code: 3 }, enabled: null, state: "enabled", expected: false },
    { name: "disabled", active: null, enabled: { code: 1 }, state: "", expected: false },
    {
      name: "unknown activity",
      active: { code: 3, termination: "timeout" },
      enabled: null,
      state: "",
      expected: false,
    },
    {
      name: "runtime-only enablement",
      active: null,
      enabled: null,
      state: "enabled-runtime",
      expected: false,
    },
  ] satisfies {
    name: string;
    active: Pick<ExecFileError, "code" | "termination"> | null;
    enabled: Pick<ExecFileError, "code"> | null;
    state: string;
    expected: boolean;
  }[])(
    "authorizes system-unit adoption only with persistent availability: $name",
    async ({ active, enabled, state, expected }) => {
      execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
        cb(active ? createExecFileError("inactive or interrupted", active) : null, "", "");
      });
      if (!active) {
        execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
          cb(enabled ? createExecFileError("disabled", enabled) : null, `${state}\n`, "");
        });
      }
      await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(expected);
      expect(execFileMock).toHaveBeenCalledTimes(active ? 1 : 2);
    },
  );
});

describe("uninstallLegacySystemdUnits", () => {
  it("preserves legacy files after interrupted discovery and refused disable", async () => {
    const tempHomeRoot = tempDirs.make("openclaw-legacy-unit-");
    const env = { HOME: path.join(tempHomeRoot, "home") };
    const unitPath = path.join(env.HOME, ".config", "systemd", "user", "clawdbot-gateway.service");
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(unitPath, "[Unit]\nDescription=Clawdbot Gateway\n", {
      encoding: "utf8",
      mode: 0o644,
    });
    await fs.writeFile(`${unitPath}.bak`, "[Unit]\nDescription=Previous Clawdbot Gateway\n", {
      mode: 0o644,
    });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args[0] === "--version") {
        expect(args).toEqual(["--version"]);
        callback(
          createExecFileError("executable probe interrupted", { termination: "signal" }),
          "",
          "",
        );
      } else if (args[1] === "is-enabled") {
        callback(null, "enabled\n", "");
      } else {
        assertUserSystemctlArgs(args, "disable", "--now", "clawdbot-gateway.service");
        callback(createExecFileError("permission denied"), "", "Permission denied");
      }
    });

    const { stdout } = createWritableStreamMock();
    await expect(uninstallLegacySystemdUnits({ env, stdout })).rejects.toThrow(
      "systemctl disable failed: Permission denied",
    );
    await fs.access(unitPath);
    await fs.access(`${unitPath}.bak`);
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
    await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o755 });
    await fs.writeFile(backupPath, "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token\n", {
      mode: 0o600,
    });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args[1] === "is-enabled") {
        callback(createExecFileError("disabled"), "disabled", "");
      } else {
        callback(null, "", "");
      }
    });

    const units = await uninstallLegacySystemdUnits({
      env,
      stdout: createWritableStreamMock().stdout,
    });

    expect(units).toMatchObject([{ name: "clawdbot-gateway", exists: false, enabled: false }]);
    await expect(fs.access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("uninstallUserSystemdGatewayUnit", () => {
  it.each(["absent", "unavailable", "disable-refused", "legacy", "reload-failed"] as const)(
    "removes only safely disabled user units: %s",
    async (scenario) => {
      const { env, unitPath: canonicalPath } = await createSystemdFixture("user");
      if (scenario === "legacy") {
        env.OPENCLAW_PROFILE = "lisa";
      }
      const unitName = scenario === "legacy" ? "openclaw-lisa.service" : GATEWAY_SERVICE;
      const unitPath = path.join(path.dirname(canonicalPath), unitName);
      if (scenario !== "absent") {
        await writeUnitFixture(
          unitPath,
          scenario === "legacy"
            ? "[Unit]\nDescription=OpenClaw Gateway (profile: lisa)\n"
            : "[Unit]\nDescription=OpenClaw Gateway\n",
        );
      }
      if (scenario === "absent" || scenario === "legacy") {
        await writeUnitFixture(
          `${unitPath}.bak`,
          scenario === "legacy"
            ? "[Unit]\nDescription=Previous gateway\n"
            : "Environment=OPENCLAW_GATEWAY_TOKEN=orphaned-token\n",
          scenario === "legacy" ? 0o644 : 0o600,
        );
      }
      if (scenario === "unavailable") {
        execFileMock.mockImplementation(
          execFileResult(createExecFileError("spawn systemctl ENOENT", { code: "ENOENT" }), "", ""),
        );
      } else {
        execFileMock
          .mockImplementationOnce(
            systemctlVersionResult(
              scenario === "disable-refused"
                ? [
                    createExecFileError("executable probe interrupted", { termination: "signal" }),
                    "",
                    "",
                  ]
                : undefined,
            ),
          )
          .mockImplementationOnce(
            systemctlUserResult(
              scenario === "disable-refused"
                ? [createExecFileError("permission denied", { code: 1 }), "", "Permission denied"]
                : [null, "", ""],
              "disable",
              "--now",
              unitName,
            ),
          );
        if (scenario === "legacy" || scenario === "reload-failed") {
          execFileMock.mockImplementationOnce(
            systemctlUserResult(
              scenario === "reload-failed"
                ? [createExecFileError("bus unavailable", { code: 1 }), "", "Bus unavailable"]
                : [null, "", ""],
              "daemon-reload",
            ),
          );
        }
      }
      const { write, stdout } = createWritableStreamMock();
      const operation = uninstallUserSystemdGatewayUnit({ env, stdout });
      if (scenario === "disable-refused") {
        await expect(operation).rejects.toThrow("systemctl disable failed: Permission denied");
        await fs.access(unitPath);
        expect(execFileMock).toHaveBeenCalledTimes(2);
        return;
      }
      if (scenario === "reload-failed") {
        await expect(operation).rejects.toThrow("systemctl daemon-reload failed: Bus unavailable");
      } else {
        expect(await operation).toMatchObject({
          unitName,
          unitPath,
          removed: scenario !== "absent",
          disabled: scenario !== "unavailable",
        });
      }
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "absent" || scenario === "legacy") {
        await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (scenario === "absent") {
        expect(requireFirstWrite(write)).toContain("User-scope systemd unit not found");
      }
      if (scenario === "unavailable") {
        expect(write.mock.calls.map((call) => String(call[0])).join("")).toContain(
          "systemctl unavailable; removing unit file only",
        );
      }
    },
  );
});

describe("systemd service control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });

  it("checks system ownership for the selected legacy user unit", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      const p = pathLikeToString(target);
      if (p.includes("/.config/systemd/user/") && p.endsWith("/openclaw-lisa.service")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(
      new Error("same-name system ownership"),
    );
    execFileMock.mockImplementationOnce(execFileSuccess());

    await expect(
      startSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: { HOME: TEST_MANAGED_HOME, OPENCLAW_PROFILE: "lisa" },
      }),
    ).rejects.toThrow("same-name system ownership");

    expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledWith("openclaw-lisa.service");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each(["start", "stop"] as const)(
    "reports the %s mutation despite observer or output failure",
    async (action) => {
      const sequence: string[] = [];
      if (action === "start") {
        execFileMock.mockImplementationOnce(execFileSuccess());
        execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "reset-failed", GATEWAY_SERVICE);
          sequence.push(args[1] ?? "");
          cb(createExecFileError("unit not loaded"), "", `Unit ${GATEWAY_SERVICE} not loaded.`);
        });
      }
      execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, action, GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(null, "", "");
      });
      const write = vi.fn(() => {
        if (action === "stop") {
          throw new Error("output failed");
        }
      });
      const onMutation = vi.fn(() => {
        if (action === "start") {
          throw new Error("audit failed");
        }
      });
      const operation = (action === "start" ? startSystemdService : stopSystemdService)({
        stdout: createWritableStreamMock(write).stdout,
        env: {},
        onMutation,
      });
      if (action === "start") {
        await expect(operation).resolves.toBeUndefined();
        expect(sequence).toEqual(["reset-failed", "start"]);
        expect(
          expectDefined(onMutation.mock.invocationCallOrder[0], "start audit call order"),
        ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
        expect(requireFirstWrite(write)).toContain("Started systemd service");
      } else {
        await expect(operation).rejects.toThrow("output failed");
      }
      expect(onMutation).toHaveBeenCalledWith({ mode: `systemctl-${action}` });
    },
  );

  it.each([false, true])(
    "surfaces stop failures at the correct manager boundary (unavailable=%s)",
    async (unavailable) => {
      if (unavailable) {
        vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
          throw new Error("no user info");
        });
        execFileMock.mockImplementationOnce(
          execFileResult(
            createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
            "",
            "",
          ),
        );
      } else {
        execFileMock.mockImplementationOnce(
          execFileResult(createExecFileError("stop failed", { code: 1 }), "", "permission denied"),
        );
      }
      const operation = stopSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: unavailable ? { USER: "", LOGNAME: "" } : {},
      });
      if (unavailable) {
        await expect(operation).rejects.toMatchObject({ reason: "systemd-user-bus-unavailable" });
      } else {
        await expect(operation).rejects.toThrow("systemctl stop failed: permission denied");
      }
    },
  );

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
        : { SUDO_USER: "debian", USER: "root-env-stale", LOGNAME: "root-env-stale" };
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
        rootManager
          ? systemctlUserSuccess(...args)
          : systemctlMachineUserSuccess("debian", ...args);
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
