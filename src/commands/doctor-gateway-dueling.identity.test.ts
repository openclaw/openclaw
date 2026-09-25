import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ExecResult } from "../daemon/exec-file.js";
import { readSystemdServiceExecStart } from "../daemon/systemd-service-files.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { maybeResolveDuelingSystemdGatewayScopes } from "./doctor-gateway-dueling.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

const native = vi.hoisted(() => ({
  exec: vi.fn<typeof import("../daemon/exec-file.js").execFileUtf8>(),
  uninstall:
    vi.fn<typeof import("../daemon/systemd-lifecycle.js").uninstallUserSystemdGatewayUnit>(),
}));
vi.mock("../daemon/exec-file.js", () => ({ execFileUtf8: native.exec }));
vi.mock("../daemon/systemd-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-lifecycle.js")>()),
  uninstallUserSystemdGatewayUnit: native.uninstall,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const success = (stdout = ""): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});
const property = (type: string, data: unknown) => ({ type, data });

type Difference =
  | "account"
  | "user profile"
  | "profile environment"
  | "profile argument"
  | "state file"
  | "config file"
  | "node service"
  | "port"
  | "unavailable"
  | "confirmation drift";
type Installation =
  | "named"
  | "reverse aliases"
  | "default"
  | "canonical default"
  | "Compose env ports"
  | "explicit relocated";

async function exerciseDoctor(installation: Installation, difference?: Difference) {
  const home = await fs.realpath(dirs.make("doctor-dueling-identity-"));
  const profile =
    installation === "default" || installation === "canonical default" ? undefined : "lisa";
  const explicit = installation === "explicit relocated";
  const userName = explicit
    ? "operator-gateway.service"
    : installation === "reverse aliases"
      ? "openclaw-lisa.service"
      : profile
        ? "openclaw-gateway-lisa.service"
        : "openclaw-gateway.service";
  const systemName =
    explicit || installation === "canonical default"
      ? userName
      : installation === "reverse aliases"
        ? "openclaw-gateway-lisa.service"
        : profile
          ? "openclaw-lisa.service"
          : "openclaw.service";
  const userPath = path.join(home, ".config/systemd/user", userName);
  const systemPath = `/etc/systemd/system/${systemName}`;
  const systemFile = path.join(home, "system-unit.service");
  const packageRoot = path.join(home, "package");
  const entrypoint = path.join(packageRoot, "openclaw.mjs");
  const stateDir = path.join(
    home,
    explicit ? "operator-state" : `.openclaw${profile ? "-lisa" : ""}`,
  );
  const configPath = path.join(stateDir, explicit ? "operator.json" : "openclaw.json");
  await fs.mkdir(path.dirname(userPath), { recursive: true });
  await fs.mkdir(packageRoot);
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(entrypoint, "");
  await fs.writeFile(configPath, JSON.stringify({ gateway: { port: 18789 } }));
  const args = [
    process.execPath,
    entrypoint,
    "gateway",
    ...(installation === "Compose env ports" ? [] : ["--port", "18789"]),
  ];
  const environment: Record<string, string> = {
    HOME: home,
    ...(profile ? { OPENCLAW_PROFILE: profile } : {}),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SERVICE_KIND: "gateway",
    ...(installation === "Compose env ports" ? { OPENCLAW_GATEWAY_PORT: "127.0.0.1:18789" } : {}),
  };
  const unit = (name: string) =>
    `[Service]\nExecStart=${args.join(" ")}\n${Object.entries({
      ...environment,
      OPENCLAW_SYSTEMD_UNIT: name,
    })
      .map(([key, value]) => `Environment="${key}=${value}"`)
      .join("\n")}\n`;
  await fs.writeFile(userPath, unit(userName));
  await fs.writeFile(systemFile, `${unit(systemName)}User=gateway\n`);

  // System-unit discovery uses its real paths; only this fixture's file lives under HOME.
  const access = fs.access.bind(fs);
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (filename, mode) => {
    if (filename === systemPath) {
      return access(systemFile, mode);
    }
    if (
      typeof filename === "string" &&
      ["/etc/systemd/system/", "/usr/lib/systemd/system/", "/lib/systemd/system/"].some((root) =>
        filename.startsWith(root),
      )
    ) {
      throw Object.assign(new Error("Fixture system unit absent"), { code: "ENOENT" });
    }
    return access(filename, mode);
  });
  vi.spyOn(fs, "readFile").mockImplementation((filename, options) =>
    readFile(filename === systemPath ? systemFile : filename, options),
  );
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(2001);
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "gateway",
    uid: 2001,
    gid: 2001,
    homedir: home,
    shell: "/bin/sh",
  });
  const properties = (name: string, filename: string) => ({
    FragmentPath: property("s", filename),
    DropInPaths: property("as", []),
    NeedDaemonReload: property("b", false),
    LoadState: property("s", "loaded"),
    ExecStart: property("a(sasbttttuii)", [[args[0], args, false, 0, 0, 0, 0, 0, 0, 0]]),
    WorkingDirectory: property("s", home),
    Environment: property(
      "as",
      Object.entries({ ...environment, OPENCLAW_SYSTEMD_UNIT: name }).map(
        ([key, value]) => `${key}=${value}`,
      ),
    ),
    EnvironmentFiles: property("a(sb)", []),
    UnsetEnvironment: property("as", []),
    User: property("s", "gateway"),
  });
  const userProperties = properties(userName, userPath);
  const systemProperties = properties(systemName, systemPath);
  const setSystemEnv = (patch: Record<string, string>) => {
    systemProperties.Environment = property(
      "as",
      Object.entries({ ...environment, OPENCLAW_SYSTEMD_UNIT: systemName, ...patch }).map(
        ([key, value]) => `${key}=${value}`,
      ),
    );
  };
  if (installation === "Compose env ports") {
    setSystemEnv({ OPENCLAW_GATEWAY_PORT: "[::1]:18789" });
  }
  if (difference === "account") {
    systemProperties.User = property("s", "another-account");
  } else if (difference === "user profile") {
    userProperties.Environment = property(
      "as",
      Object.entries({
        ...environment,
        OPENCLAW_PROFILE: "darlene",
        OPENCLAW_SYSTEMD_UNIT: userName,
      }).map(([key, value]) => `${key}=${value}`),
    );
    userProperties.NeedDaemonReload = property("b", true);
  } else if (difference === "profile environment") {
    setSystemEnv({ OPENCLAW_PROFILE: "darlene" });
  } else if (difference === "state file" || difference === "config file") {
    const envFile = path.join(home, "system.env");
    const key = difference === "state file" ? "OPENCLAW_STATE_DIR" : "OPENCLAW_CONFIG_PATH";
    await fs.writeFile(envFile, `${key}=${path.join(home, "other-install")}\n`);
    systemProperties.EnvironmentFiles = property("a(sb)", [[envFile, false]]);
  } else if (
    difference === "profile argument" ||
    difference === "node service" ||
    difference === "port"
  ) {
    const systemArgs =
      difference === "profile argument"
        ? [...args, "--profile", "darlene"]
        : difference === "node service"
          ? [process.execPath, entrypoint, "node", "run"]
          : [process.execPath, entrypoint, "gateway", "--port", "19890"];
    if (difference === "node service") {
      setSystemEnv({ OPENCLAW_SERVICE_KIND: "node" });
    }
    systemProperties.ExecStart = property("a(sasbttttuii)", [
      [systemArgs[0], systemArgs, false, 0, 0, 0, 0, 0, 0, 0],
    ]);
  }
  const unexpected: string[] = [];
  native.exec.mockReset().mockImplementation(async (command, commandArgs) => {
    if (command === "systemctl" && commandArgs[0] === "is-active") {
      return success();
    }
    if (command === "systemctl" && commandArgs[0] === "is-enabled") {
      return success("enabled\n");
    }
    if (command === "busctl") {
      const system = commandArgs.includes("--system");
      if (commandArgs.at(-1) === "Version") {
        return success('s "257"\n');
      }
      if (commandArgs.includes("GetNameOwner")) {
        return success(JSON.stringify(property("s", [system ? ":1.42" : ":1.43"])));
      }
      if (commandArgs.includes("GetConnectionUnixUser")) {
        return success(JSON.stringify(property("u", [system ? 0 : 2001])));
      }
      if (commandArgs.includes("GetUnit") || commandArgs.includes("LoadUnit")) {
        if (system && difference === "unavailable") {
          return { ...success(), code: 1, stderr: "Synthetic system inspection unavailable" };
        }
        if (commandArgs.at(-1) === (system ? systemName : userName)) {
          return success(
            JSON.stringify(
              property("o", [`/org/freedesktop/systemd1/unit/${system ? "system" : "user"}`]),
            ),
          );
        }
      }
      const index = commandArgs.findIndex((arg) => /\.(?:Unit|Service)$/.test(arg));
      if (index >= 0) {
        const values: Record<string, ReturnType<typeof property>> = system
          ? systemProperties
          : userProperties;
        const names = commandArgs.slice(index + 1);
        if (names.every((name) => Object.hasOwn(values, name))) {
          return success(names.map((name) => JSON.stringify(values[name])).join("\n"));
        }
      }
    }
    unexpected.push(`${command} ${commandArgs.join(" ")}`);
    return { ...success(), code: 1, stderr: "Unexpected fixture native command" };
  });
  native.uninstall.mockReset().mockResolvedValue({
    unitName: userName,
    unitPath: userPath,
    removed: true,
    disabled: true,
  });
  await withEnvAsync(
    {
      ...environment,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_GATEWAY_PORT: environment.OPENCLAW_GATEWAY_PORT,
      OPENCLAW_SYSTEMD_UNIT: explicit ? userName : undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_LAUNCHD_LABEL: undefined,
      OPENCLAW_WINDOWS_TASK_NAME: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      SUDO_USER: undefined,
      USER: "gateway",
      LOGNAME: "gateway",
      XDG_RUNTIME_DIR: path.join(home, "run"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, "run/bus")}`,
    },
    async () => {
      // A malformed transport fixture must not masquerade as a safe Doctor refusal.
      await expect(
        readSystemdServiceExecStart(process.env, {
          requireEffective: true,
          systemdReadTarget: { scope: "user", unitName: userName, unitPath: userPath },
        }),
      ).resolves.toMatchObject({ programArguments: args, sourcePath: userPath });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const prompter = createDoctorPrompter({ runtime, options: { yes: true } });
      const confirmation = vi.spyOn(prompter, "confirmRuntimeRepair");
      if (difference === "confirmation drift") {
        confirmation.mockImplementationOnce(async () => {
          setSystemEnv({
            OPENCLAW_PROFILE: "darlene",
            OPENCLAW_STATE_DIR: path.join(home, "other"),
          });
          return true;
        });
      }
      await maybeResolveDuelingSystemdGatewayScopes(runtime, prompter);
      expect(unexpected).toEqual([]);
      if (difference) {
        expect(native.uninstall).not.toHaveBeenCalled();
        expect(confirmation).toHaveBeenCalledTimes(difference === "confirmation drift" ? 1 : 0);
      } else {
        expect(confirmation).toHaveBeenCalledOnce();
        expect(native.uninstall).toHaveBeenCalledExactlyOnceWith({
          env: process.env,
          stdout: process.stdout,
          target: { scope: "user", unitName: userName, unitPath: userPath },
        });
      }
    },
  );
}

it.each<Installation>([
  "named",
  "reverse aliases",
  "default",
  "canonical default",
  "Compose env ports",
  "explicit relocated",
])(
  "Doctor requests removal of the confirmed duplicate user unit for %s installation",
  async (installation) => exerciseDoctor(installation),
);

it.each<Difference>([
  "account",
  "user profile",
  "profile environment",
  "profile argument",
  "state file",
  "config file",
  "node service",
  "port",
  "unavailable",
  "confirmation drift",
])("Doctor preserves the user unit when system identity differs: %s", async (difference) =>
  exerciseDoctor("named", difference),
);
