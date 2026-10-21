import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { ExecResult } from "./exec-file.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
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
const serviceEnv = { HOME: TEST_SERVICE_HOME };
const strict = { requireEffective: true };
const gatewayArguments = ["/usr/bin/openclaw", "gateway", "run"];
const gatewayUnitPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`;
const operatorDropIn = `${gatewayUnitPath}.d/operator.conf`;

function gatewayUnit(...directives: string[]) {
  return ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", ...directives];
}

function legacyGatewayUnit(version: string, ...directives: string[]) {
  return [
    "[Unit]",
    `Description=OpenClaw Gateway (v${version})`,
    "[Service]",
    "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
    "Environment=OPENCLAW_SERVICE_KIND=gateway",
    ...directives,
    `Environment=OPENCLAW_SERVICE_VERSION=${version}`,
    "",
  ].join("\n");
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

function environmentSnapshot(entries: Record<string, [value: string, source: string]>) {
  return {
    environment: Object.fromEntries(Object.entries(entries).map(([key, [value]]) => [key, value])),
    environmentValueSources: Object.fromEntries(
      Object.entries(entries).map(([key, [, source]]) => [key, source]),
    ),
  };
}

async function expectFiles(
  files: Record<string, string | { contents: string; mode: number } | null>,
) {
  for (const [file, expected] of Object.entries(files)) {
    if (expected === null) {
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(fs.readFile(file, "utf8")).resolves.toBe(
        typeof expected === "string" ? expected : expected.contents,
      );
      if (typeof expected !== "string") {
        expect((await fs.stat(file)).mode & 0o777).toBe(expected.mode);
      }
    }
  }
}

function readCommand(options?: Parameters<typeof readSystemdServiceExecStart>[1]) {
  return readSystemdServiceExecStart(serviceEnv, options);
}

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
  "env" | "stdout" | "programArguments" | "workingDirectory"
>;

function systemdServiceFixture(
  env: SystemdServiceFixture["env"],
  kind: "gateway" | "node",
  overrides: SystemdServiceFixtureOverrides = {},
): SystemdServiceFixture {
  return {
    env,
    stdout: createWritableStreamMock().stdout,
    programArguments: ["/usr/bin/openclaw", kind, "run"],
    workingDirectory: "/tmp",
    ...(kind === "node" ? { environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" } } : {}),
    ...overrides,
  };
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
    stage: (overrides: SystemdServiceFixtureOverrides) => {
      queueUserCommands(["status"]);
      return stageSystemdService(
        systemdServiceFixture(env, kind === "node" ? kind : "gateway", overrides),
      );
    },
    install: (overrides: SystemdServiceFixtureOverrides = {}) =>
      installSystemdService(
        systemdServiceFixture(env, kind === "node" ? kind : "gateway", overrides),
      ),
  };
}

function requireFirstWrite(write: ReturnType<typeof vi.fn>): string {
  return String(expectDefined(write.mock.calls[0]?.[0], "expected systemd status write"));
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

function systemctlUserFailure(detail: string, ...command: string[]): ExecFileMock {
  return systemctlUserResult([createExecFileError(detail), "", detail], ...command);
}

function queueUserCommands(...commands: string[][]) {
  for (const command of commands) {
    execFileMock.mockImplementationOnce(systemctlUserSuccess(...command));
  }
}

function execFileResult(...result: ExecFileResult): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(...result);
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
      systemctlUserFailure("Failed to connect to bus: No medium found", action, NODE_SERVICE),
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
    fragmentPath: params.fragmentPath ?? gatewayUnitPath,
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

function mockSystemdManagerSnapshot(overrides: Partial<SystemdManagerSnapshotFixture>): void {
  const snapshot = { programArguments: gatewayArguments, ...overrides };
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
  assertNoSystemSystemdOwnershipMock.mockReset().mockResolvedValue();
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
    execFileMock.mockImplementationOnce(
      systemctlUserFailure("Failed to connect to bus: Permission denied", "status"),
    );
    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

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
            createExecFileError("Command failed: systemctl --user is-enabled custom-unit.service", {
              code: 4,
            }),
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
      await expect(result).rejects.toThrow(
        "systemctl --user is-enabled: exit 1; permission denied",
      );
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
          unitPath: `${TEST_MANAGED_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
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
        HOME: TEST_MANAGED_HOME,
        OPENCLAW_SERVICE_KIND: "node",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
      }),
    ).resolves.toBeNull();
  });

  it("isSystemdServiceEnabled queries the marker-owned custom system unit name", async () => {
    mockUnitFileLayout({ system: false });
    mockSystemMarker();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", "openclaw.service"]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it.each([false, true])("restarts system-scope units only as root (root=%s)", async (root) => {
    mockUnitFileLayout({ system: root ? "/etc/systemd/system/openclaw-gateway.service" : false });
    if (!root) {
      mockSystemMarker();
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
      execFileMock.mockImplementation((_command, args, _options, callback) => {
        if (source === "availability" || !args.includes("status")) {
          throw error;
        }
        callback(null, "", "");
      });

      await expect(
        readSystemdServiceRuntime(
          { HOME: TEST_MANAGED_HOME },
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
    existsSyncMock.mockImplementation((file) =>
      pathLikeToString(file).endsWith("/systemd/private"),
    );
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(createExecFileError("manager unavailable"), "", "");
    });
    vi.spyOn(await import("./systemd-peer-native.js"), "openSystemdUserManager").mockRejectedValue(
      error,
    );

    await expect(
      readSystemdServiceRuntime(
        { HOME: TEST_MANAGED_HOME },
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
    const detail = "Permission denied while reading systemd state";
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(execFileResult(createExecFileError(detail), "", detail));

    await expect(
      readSystemdServiceRuntime(
        { HOME: TEST_MANAGED_HOME },
        { commandInspection: { kind: "present" } },
      ),
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
});

describe("readSystemdServiceExecStart", () => {
  it("preserves unsettled cleanup instead of returning a managed command fallback", async () => {
    mockReadGatewayServiceFile(gatewayUnit());
    const error = new CommandProcessCleanupError();
    execFileMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(readCommand()).rejects.toBe(error);
  });

  it.each(["uid", "revoked-before", "revoked-load", "manager-change"] as const)(
    "reads a collected definition only with current recovery ownership (%s)",
    async (fault) => {
      mockReadGatewayServiceFile(gatewayUnit());
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
          output = buildSystemdManagerPropertyOutput({ programArguments: gatewayArguments });
        }
        callback(null, output, "");
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

  it.each(["global", "absent"] as const)(
    "loaded-only inspection does not activate or adopt an unloaded %s definition",
    async (scenario) => {
      execFileMock.mockReset();
      mockMissingBase();
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
      const result = readCommand({ ...strict, requireLoaded: true });
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
    await expect(readCommand(strict)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledWith(
      "busctl",
      expect.arrayContaining(["LoadUnit", GATEWAY_SERVICE]),
      expect.anything(),
      expect.anything(),
    );

    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("unreadable-service-secret-canary"), { code: "EACCES" }),
    );
    await expect(readCommand(strict)).rejects.toThrow(
      `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
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
    mockSystemdManagerSnapshot({
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
    mockReadGatewayServiceFile(gatewayUnit());
    mockSystemdManagerProperties(
      new Error("must not inspect a missing service"),
      buildSystemdUnitPropertyOutput({ fragmentPath: "", loadState: "not-found" }),
    );
    await expect(readCommand(strict)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "wrong property types", output: JSON.stringify({ type: "s", data: "bad" }) },
    { name: "malformed LoadUnit", loaded: JSON.stringify({ type: "o", data: [] }) },
  ])("strictly rejects $name with a missing local base", async ({ output, loaded }) => {
    mockMissingBase();
    mockSystemdManagerProperties(
      output ??
        buildSystemdManagerPropertyOutput({ programArguments: ["/usr/bin/openclaw", "gateway"] }),
    );
    if (loaded) {
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, loaded, "");
      });
    }
    await expect(readCommand(strict)).rejects.toThrow();
    if (output) {
      await expect(readCommand()).resolves.toBeNull();
    }
  });

  it("enforces only active EnvironmentFile inputs (EACCES)", async () => {
    const inactive = `${TEST_SERVICE_HOME}/.openclaw/retired.env`;
    const active = `${TEST_SERVICE_HOME}/.openclaw/current.env`;
    const dropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/environment.conf`;
    mockReadGatewayServiceFile(gatewayUnit(`EnvironmentFile=${inactive}`), {
      [inactive]: Object.assign(new Error("retired environment unavailable"), { code: "EACCES" }),
      [active]: "ACTIVE_VALUE=current\n",
      [dropIn]: `[Service]\nEnvironmentFile=\nEnvironmentFile=${active}\n`,
    });
    mockSystemdManagerSnapshot({
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
    mockSystemdManagerSnapshot({
      environmentFiles: [[inactive, false]],
    });
    await expect(readCommand(strict)).rejects.toThrow("retired environment unavailable");
  });

  it("reports one manager-effective command snapshot while retaining the managed base definition", async () => {
    const effectiveArguments = ["/opt/operator/openclaw", "gateway", "run"];
    const managedEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/managed.env`;
    const effectiveEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    const dropInPath = operatorDropIn;
    mockReadGatewayServiceFile(
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
    expect(execFileMock.mock.calls.map((call) => call[2].timeout)).toEqual([400, 550, 800]);
    expect(execFileMock.mock.calls.some((call) => call[1].includes("LoadUnit"))).toBe(false);
  });

  it("reports a working-directory override without a pending manager reload", async () => {
    const dropInPath = operatorDropIn;
    const readFile = mockReadGatewayServiceFile(gatewayUnit(), {
      [dropInPath]: "[Service]\nWorkingDirectory=/srv/operator-openclaw",
    });
    mockSystemdManagerSnapshot({
      workingDirectory: "/srv/operator-openclaw",
      dropInPaths: [dropInPath],
      needDaemonReload: false,
    });

    const command = await readCommand();

    expect(command?.reloadPending).toBeUndefined();
    expect(command?.managedOverrides).toEqual({ launcher: "working-directory" });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("retains loaded drop-in ownership after a backslash comment even when values equal the base", async () => {
    const comment = "# operator note \\";
    const dropInPath = operatorDropIn;
    mockReadGatewayServiceFile(
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
    mockSystemdManagerSnapshot({
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
    const firstDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/10-file.conf`;
    const resetDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/20-reset.conf`;
    const operatorEnv = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    mockReadGatewayServiceFile(
      gatewayUnit("Environment=FOO=base BAR=base", "UnsetEnvironment=BAR"),
      {
        [firstDropIn]: `[Service]\nEnvironmentFile=${operatorEnv}\n`,
        [resetDropIn]: "[Service]\nEnvironmentFile=\nUnsetEnvironment=FOO\nUnsetEnvironment=\n",
        [operatorEnv]: "FOO=operator\n",
      },
    );
    mockSystemdManagerSnapshot({
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
    const properties = buildSystemdUnitPropertyOutput({}).replace(
      JSON.stringify({ type: "b", data: false }),
      JSON.stringify({ type: "b", data: "false" }),
    );
    mockReadGatewayServiceFile(
      gatewayUnit("WorkingDirectory=/srv/managed-openclaw", "Environment=MANAGED_VALUE=base"),
    );
    mockSystemdManagerProperties(
      buildSystemdManagerPropertyOutput({
        programArguments: ["/opt/operator/openclaw", "gateway", "run"],
        environment: ["OPERATOR_VALUE=effective"],
      }),
      properties,
    );

    await expect(readCommand(strict)).rejects.toThrow();
    expect(execFileMock.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(Math.floor(5_000 / 3));
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
    const staleFile = `${TEST_SERVICE_HOME}/.openclaw/stale.env`;
    const readFileSpy = mockReadGatewayServiceFile(
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
    expect(unit).toContain('Environment="OTHER_SETTING=kept value %h/%%h"');
    expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(unit.split("\n")).toContain("ExecStart=/usr/bin/openclaw gateway run");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an unsafe legacy unit intact for full installer regeneration", async () => {
    const { env, unitPath } = await createSystemdFixture("gateway");
    const previous = legacyGatewayUnit("2026.6.35", "ExecStart=/usr/bin/openclaw gateway");
    await writeUnitFixture(unitPath, previous);
    await fs.chmod(unitPath, 0o664);

    await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(false);

    await expectFiles({ [unitPath]: { contents: previous, mode: 0o664 } });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["reset managed markers", true, undefined],
    ["ownership refused before publication", false, 0],
    ["ownership refused after publication", false, 2],
  ] as const)("preserves legacy metadata: %s", async (_name, reset, admitted) => {
    const { env, unitPath } = await createSystemdFixture("gateway");
    const previous = legacyGatewayUnit("2026.7.1-2", ...(reset ? ["Environment="] : []));
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
    [0, "unit", "system scope owns openclaw-gateway-stage-test.service"],
    [1, "none", "system ownership appeared"],
    [2, "both", "system ownership appeared"],
    [3, "none", "system ownership appeared before activation"],
  ] as const)(
    "preserves prior files when system ownership refuses publication at checkpoint %s",
    async (checkpoint, existing, error) => {
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
      queueUserCommands(["status"]);
      for (let index = 0; index < checkpoint; index++) {
        assertNoSystemSystemdOwnershipMock.mockResolvedValueOnce();
      }
      if (checkpoint === 3) {
        assertNoSystemSystemdOwnershipMock.mockRejectedValue(new Error(error));
      } else {
        assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(new Error(error));
      }
      const withToken = checkpoint === 1 || checkpoint === 2;
      const fixture = systemdServiceFixture(env, "gateway", {
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          ...(withToken ? { OPENCLAW_GATEWAY_TOKEN: "new-token" } : {}),
        },
        ...(withToken ? { environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" } } : {}),
      });
      await expect(
        (checkpoint === 3 ? installSystemdService : stageSystemdService)(fixture),
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
    await writeUnitFixture(envFilePath, `OPENAI_API_KEY=${fileBackedOpenAiKey}\n`, 0o600);
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
    expect(command).toMatchObject({
      environment: { OPENAI_API_KEY: fileBackedOpenAiKey },
      environmentValueSources: {
        OPENAI_API_KEY: "file",
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
      },
    });

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
    expect(plan).toMatchObject({
      environmentValueSources: { OPENAI_API_KEY: "file" },
      environment: { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENAI_API_KEY" },
    });

    queueUserCommands(["status"]);
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

  it("preserves the gateway environment while clearing node-managed values", async () => {
    const { env, unitPath, envFilePath, nodeEnvFilePath } = await createSystemdFixture("gateway");
    const legacyGatewayEnvFile = "OPENCLAW_GATEWAY_TOKEN=stale-token\n";
    await fs.writeFile(envFilePath, legacyGatewayEnvFile, { encoding: "utf8", mode: 0o600 });
    await writeUnitFixture(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-node-token\n", 0o600);
    queueUserCommands(["status"]);
    await stageSystemdService(
      systemdServiceFixture(env, "node", {
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
    const { stage, unitPath } = await createSystemdFixture("gateway");
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
    const { stage, unitPath } = await createSystemdFixture("gateway");
    const backupPath = `${unitPath}.bak`;
    const previous =
      "[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept\n";
    await writeUnitFixture(backupPath, previous, 0o640);
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
    const { stage, stateDir, unitPath, envFilePath } = await createSystemdFixture("gateway");
    await writeUnitFixture(
      unitPath,
      "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=STALE_MANAGED_KEY\n",
    );
    await writeUnitFixture(
      envFilePath,
      [
        "OPENCLAW_GATEWAY_TOKEN=stale-gateway-token",
        "OPENROUTER_API_KEY=or-operator-key",
        "NODE_OPTIONS=--require=/tmp/stale-preload.cjs",
        "STALE_MANAGED_KEY=stale-managed",
      ].join("\n") + "\n",
      0o600,
    );

    await writeUnitFixture(
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
    const { stage, stateDir, unitPath, envFilePath } = await createSystemdFixture("gateway");
    await writeUnitFixture(
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

    await writeUnitFixture(path.join(stateDir, ".env"), "LLM_API_KEY=${UNRESOLVED}\n", 0o600);

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
    const { install, unitPath } = await createSystemdFixture("node");
    queueUserCommands(["status"], ["daemon-reload"], ["restart", NODE_SERVICE]);

    await install({ preserveAutoStart: true, description: "OpenClaw Node Host" });

    const unit = await fs.readFile(unitPath, "utf8");
    expect(unitPath).toMatch(/openclaw-node\.service$/);
    expect(unit).toContain("Description=OpenClaw Node Host");
    expect(unit).toContain("openclaw node run");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an equal-valued launcher override", "ExecStart=/usr/bin/openclaw node run", true],
    ["an environment-only override", "Environment=NODE_COMPILE_CACHE=/tmp/cache", false],
  ] as const)(
    "warns after installation only when %s controls the effective launcher",
    async (_name, directive, shouldWarn) => {
      const { install, unitPath } = await createSystemdFixture("node");
      const dropInPath = path.join(`${unitPath}.d`, "operator.conf");
      await writeUnitFixture(dropInPath, `[Service]\n${directive}\n`);
      await writeUnitFixture(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n");
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
      const { env, unitPath } = await createSystemdFixture("node");
      await writeUnitFixture(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n");
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: ["OPENCLAW_SYSTEMD_UNIT=openclaw-node"],
        fragmentPath: unitPath,
      });
      const failure =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new Error("fixture optional inspection failure");
      let activated = false;
      let failed = false;
      const managerQuery = expectDefined(execFileMock.getMockImplementation(), "manager fixture");
      execFileMock.mockImplementation((command, args, options, callback) => {
        if (command === "systemctl") {
          activated ||= args.includes("restart");
          callback(null, args.includes("is-enabled") ? "enabled\n" : "", "");
          return;
        }
        if (activated) {
          failed = true;
          throw failure;
        }
        managerQuery(command, args, options, callback);
      });
      const { write, stdout } = createWritableStreamMock();
      const operation = installSystemdService({
        ...systemdServiceFixture(env, "node", { warn: vi.fn() }),
        stdout,
      });

      if (kind === "ordinary") {
        await expect(operation).resolves.toEqual({ unitPath });
        expect(write).toHaveBeenCalled();
      } else {
        await expect(operation).rejects.toBe(failure);
        expect(write).not.toHaveBeenCalled();
      }
      expect(activated).toBe(true);
      expect(failed).toBe(true);
    },
  );

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    const { install } = await createSystemdFixture("node");
    queueUserCommands(["status"], ["daemon-reload"]);
    execFileMock.mockImplementationOnce(
      systemctlUserResult(
        [
          createExecFileError("enable failed"),
          "",
          "Unit file openclaw-node.service does not exist.",
        ],
        "enable",
        NODE_SERVICE,
      ),
    );
    queueUserCommands(["daemon-reload"], ["enable", NODE_SERVICE], ["restart", NODE_SERVICE]);
    await install();

    expect(execFileMock).toHaveBeenCalledTimes(6);
  });

  it("does not retry an interrupted restart reporting a missing unit (signal)", async () => {
    const { install } = await createSystemdFixture("node");
    execFileMock.mockImplementation(execFileSuccess());
    queueUserCommands(["status"], ["daemon-reload"], ["enable", NODE_SERVICE]);
    execFileMock.mockImplementationOnce(
      systemctlUserResult(
        [
          createExecFileError("restart interrupted", { termination: "signal" }),
          "",
          "Unit file openclaw-node.service does not exist.",
        ],
        "restart",
        NODE_SERVICE,
      ),
    );

    await expect(install()).rejects.toThrow("systemctl restart failed:");
    expect(execFileMock.mock.calls.map(([, args]) => args[1])).toEqual([
      "status",
      "daemon-reload",
      "enable",
      "restart",
      "daemon-reload",
      "disable",
      "stop",
    ]);
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    const { install } = await createSystemdFixture("node");
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
    const { env, unitPath, nodeEnvFilePath } = await createSystemdFixture("node");
    await writeUnitFixture(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
    await writeUnitFixture(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=preserved-token\n", 0o600);
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserFailure(detail, "disable", "--now", NODE_SERVICE));

    const { stdout } = createWritableStreamMock();

    await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
      `systemctl disable failed: ${detail}`,
    );
    await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
    await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toContain("preserved-token");
  });

  it("keeps missing or inactive systemd unit removal idempotent", async () => {
    const detail = "Failed to stop openclaw-node.service: Unit openclaw-node.service not loaded.";
    const { env } = await createSystemdFixture("node");
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserFailure(detail, "disable", "--now", NODE_SERVICE));

    const { write, stdout } = createWritableStreamMock();

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
      const { env, unitPath, nodeEnvFilePath } = await createSystemdFixture("node");
      await writeUnitFixture(unitPath, "[Unit]\nDescription=OpenClaw Node\n");
      if (scenario !== "password-only") {
        await writeUnitFixture(`${unitPath}.bak`, "[Unit]\nDescription=Previous OpenClaw Node\n");
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
          systemctlUserResult(
            scenario === "reload-failed"
              ? [createExecFileError("bus unavailable", { code: 1 }), "", "Bus unavailable"]
              : [null, "", ""],
            "daemon-reload",
          ),
        );
      }
      const { write, stdout } = createWritableStreamMock();
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
        expect(execFileMock.mock.calls.map(([, args]) => args[1])).toEqual([
          "status",
          "disable",
          "daemon-reload",
        ]);
      }
    },
  );
});

describe("isSystemUnitActiveAndEnabled", () => {
  it("keeps failed user activity probes distinguishable from inactivity", async () => {
    const detail = "Failed to connect to bus: Permission denied";
    execFileMock.mockImplementation(
      execFileResult(createExecFileError(detail, { code: 1 }), "", detail),
    );
    await expect(
      isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, "user"),
    ).resolves.toEqual({ ok: false, error: detail });
  });

  it.each([
    ["inactive", 3, null, "enabled"],
    ["disabled", null, 1, ""],
    ["runtime-only enablement", null, null, "enabled-runtime"],
  ] as const)(
    "authorizes system-unit adoption only with persistent availability: %s",
    async (_name, active, enabled, state) => {
      execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
        cb(
          active ? createExecFileError("inactive or interrupted", { code: active }) : null,
          "",
          "",
        );
      });
      if (!active) {
        execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
          expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
          cb(enabled ? createExecFileError("disabled", { code: enabled }) : null, `${state}\n`, "");
        });
      }
      await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
      expect(execFileMock).toHaveBeenCalledTimes(active ? 1 : 2);
    },
  );
});

describe("uninstallLegacySystemdUnits", () => {
  it.each([
    ["", "EACCES"],
    ["", "EIO"],
    [".bak", "EACCES"],
    [".bak", "EIO"],
  ])("reports legacy %s inspection failure %s before cleanup", async (suffix, code) => {
    const env = { HOME: tempDirs.make("openclaw-legacy-inspection-") };
    const unitPath = path.join(env.HOME, ".config/systemd/user/clawdbot-gateway.service");
    const inspectedPath = `${unitPath}${suffix}`;
    const definition = "[Unit]\nDescription=Legacy inspection fixture\n";
    await writeUnitFixture(inspectedPath, definition);
    const inspectionError = Object.assign(new Error("legacy inspection failed"), { code });
    vi.spyOn(fs, "access").mockImplementation(async (pathname, mode) => {
      if (pathLikeToString(pathname) === inspectedPath) {
        throw inspectionError;
      }
      return access(pathname, mode);
    });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args[0] === "--version") {
        callback(null, "systemd 252", "");
      } else {
        callback(createExecFileError("disabled"), "disabled", "");
      }
    });
    const { write, stdout } = createWritableStreamMock();

    await expect(uninstallLegacySystemdUnits({ env, stdout })).rejects.toBe(inspectionError);
    await expect(fs.readFile(inspectedPath, "utf8")).resolves.toBe(definition);
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves legacy files after interrupted discovery and refused disable", async () => {
    const tempHomeRoot = tempDirs.make("openclaw-legacy-unit-");
    const env = { HOME: path.join(tempHomeRoot, "home") };
    const unitPath = path.join(env.HOME, ".config", "systemd", "user", "clawdbot-gateway.service");
    const previous = "[Unit]\nDescription=Clawdbot Gateway\n";
    const backup = "[Unit]\nDescription=Previous Clawdbot Gateway\n";
    await writeUnitFixture(unitPath, previous);
    await writeUnitFixture(`${unitPath}.bak`, backup);
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
    await expectFiles({ [unitPath]: previous, [`${unitPath}.bak`]: backup });
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
    await writeUnitFixture(backupPath, "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token\n", 0o600);
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
    await expectFiles({ [backupPath]: null });
  });
});

it.each(["absent", "unavailable", "legacy", "reload-failed"] as const)(
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
        .mockImplementationOnce(systemctlVersionResult())
        .mockImplementationOnce(systemctlUserResult([null, "", ""], "disable", "--now", unitName));
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
    await expectFiles({ [unitPath]: null });
    if (scenario === "absent" || scenario === "legacy") {
      await expectFiles({ [`${unitPath}.bak`]: null });
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
describe("systemd service control", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
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

  it("reports the start mutation before output despite observer failure", async () => {
    const sequence: string[] = [];
    execFileMock.mockImplementationOnce(execFileSuccess());
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "reset-failed", GATEWAY_SERVICE);
      sequence.push(args[1] ?? "");
      cb(createExecFileError("unit not loaded"), "", `Unit ${GATEWAY_SERVICE} not loaded.`);
    });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "start", GATEWAY_SERVICE);
      sequence.push(args[1] ?? "");
      cb(null, "", "");
    });
    const write = vi.fn();
    const onMutation = vi.fn(() => {
      throw new Error("audit failed");
    });
    const operation = startSystemdService({
      stdout: createWritableStreamMock(write).stdout,
      env: { HOME: TEST_MANAGED_HOME },
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
    execFileMock.mockImplementationOnce(
      execFileResult(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      ),
    );
    const operation = stopSystemdService({
      stdout: createWritableStreamMock().stdout,
      env: { HOME: TEST_MANAGED_HOME, USER: "", LOGNAME: "" },
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
            HOME: TEST_MANAGED_HOME,
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
