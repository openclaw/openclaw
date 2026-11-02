import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const native = vi.hoisted(() => ({
  systemDirectories: [] as string[],
  systemBus: vi.fn<typeof import("../daemon/systemd-exec.js").execBusctlSystem>(),
  userBus: vi.fn(),
  systemctl: vi.fn(),
  exec: vi.fn<typeof import("../daemon/exec-file.js").execFileUtf8>(),
}));
vi.mock("../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-exec.js")>()),
  execBusctlSystem: native.systemBus,
  execBusctlUser: native.userBus,
  execSystemctl: native.systemctl,
}));
vi.mock("../daemon/exec-file.js", async (original) => ({
  ...(await original<typeof import("../daemon/exec-file.js")>()),
  execFileUtf8: native.exec,
}));
vi.mock("../daemon/systemd-unit-load-paths.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-unit-load-paths.js")>()),
  DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS: native.systemDirectories,
}));
vi.mock("./gateway-run-argv.js", async (original) => ({
  ...(await original<typeof import("./gateway-run-argv.js")>()),
  isGatewayRunInvocationArgv: () => false,
}));

import { nativeExit } from "../daemon/systemd-exec.test-support.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { assertGatewayServiceSchemaMigrationAllowed } from "../state/openclaw-state-service-installation.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { inspectCliGatewayServiceInstallation } from "./run-main-service-installation.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const property = (type: string, data: unknown) => ({ type, data });
let callerHome: string;
let serviceHome: string;
let assignments: string[];
let fileSpecs: [string, boolean][];
let managerEnvironment: string[];
let serviceOverrides: Record<string, ReturnType<typeof property>>;
let isolationUnavailable: boolean;

beforeEach(async () => {
  mockProcessPlatform("linux");
  const root = dirs.make("service-account-");
  callerHome = path.join(root, "caller");
  serviceHome = path.join(root, "service");
  const packageRoot = path.join(root, "older-package");
  const unitDirectory = path.join(root, "systemd");
  await Promise.all(
    [callerHome, serviceHome, packageRoot, unitDirectory].map((dir) => fs.mkdir(dir)),
  );
  const entrypoint = path.join(packageRoot, "openclaw.mjs");
  const unitPath = path.join(unitDirectory, "openclaw-gateway.service");
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","version":"2026.7.1"}',
    ),
    fs.writeFile(entrypoint, ""),
    fs.writeFile(unitPath, `[Service]\nExecStart=${process.execPath} ${entrypoint} gateway\n`),
  ]);
  native.systemDirectories.splice(0, native.systemDirectories.length, unitDirectory);
  assignments = [];
  fileSpecs = [];
  managerEnvironment = [];
  serviceOverrides = {};
  isolationUnavailable = false;
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "caller",
    uid: 2001,
    gid: 2001,
    homedir: callerHome,
    shell: "/bin/sh",
  });
  native.userBus.mockReset().mockRejectedValue(new Error("Unexpected user bus query"));
  native.systemctl.mockReset().mockRejectedValue(new Error("Unexpected systemctl call"));
  native.exec.mockReset().mockImplementation(async (command, args) => {
    expect(command).toBe("/usr/bin/getent");
    expect(args).toEqual(["passwd", "service"]);
    return nativeExit(`service:x:2002:2002::${serviceHome}:/bin/sh\n`);
  });
  native.systemBus.mockReset().mockImplementation(async (args) => {
    const reply = (type: string, data: unknown) => nativeExit(JSON.stringify(property(type, data)));
    if (args.includes("GetNameOwner")) {
      return reply("s", [":1.42"]);
    }
    if (args.includes("GetConnectionUnixUser")) {
      return reply("u", [0]);
    }
    if (args.includes("GetUnitFileState")) {
      return reply("s", ["enabled"]);
    }
    if (args.includes("GetUnit") || args.includes("LoadUnit")) {
      return reply("o", ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"]);
    }
    if (args.includes("get-property") && args.includes("org.freedesktop.systemd1.Manager")) {
      return reply("as", managerEnvironment);
    }
    if (isolationUnavailable && args.includes("RootDirectory")) {
      throw new Error("State namespace inspection denied");
    }
    const properties: Record<string, unknown> = {
      FragmentPath: property("s", unitPath),
      DropInPaths: property("as", []),
      NeedDaemonReload: property("b", false),
      LoadState: property("s", "loaded"),
      UnitFileState: property("s", "enabled"),
      ActiveState: property("s", "active"),
      CanStart: property("b", true),
      RefuseManualStart: property("b", false),
      ExecStart: property("a(sasbttttuii)", [
        [process.execPath, [process.execPath, entrypoint, "gateway"], false, 0, 0, 0, 0, 0, 0, 0],
      ]),
      WorkingDirectory: property("s", packageRoot),
      Environment: property("as", assignments),
      EnvironmentFiles: property("a(sb)", fileSpecs),
      UnsetEnvironment: property("as", []),
      User: property("s", "service"),
      PAMName: property("s", ""),
      RootDirectory: property("s", ""),
      RootImage: property("s", ""),
      BindPaths: property("a(ssbt)", []),
      BindReadOnlyPaths: property("a(ssbt)", []),
      TemporaryFileSystem: property("a(ss)", []),
      MountImages: property("a(ssba(ss))", []),
      ExtensionImages: property("a(sba(ss))", []),
      ExtensionDirectories: property("as", []),
      PrivateTmp: property("b", false),
      ProtectHome: property("s", "no"),
      PassEnvironment: property("as", []),
      ...serviceOverrides,
    };
    const index = args.findIndex((arg) => /\.(Unit|Service)$/u.test(arg));
    if (index < 0) {
      throw new Error("Unexpected native query");
    }
    return nativeExit(
      args
        .slice(index + 1)
        .map((name) => JSON.stringify(properties[name]))
        .join("\n"),
    );
  });
});
afterEach(() => {
  expect(native.userBus).not.toHaveBeenCalled();
  expect(native.systemctl).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("foreign system Gateway migration guard", () => {
  it.each([
    ["different account home", false],
    ["shared account home", true],
    ["explicit shared state", true],
    ["explicit separate state", false],
    ["relative shared state", true],
    ["symlink to shared state", true],
    ["hard link to shared database", true],
    ["environment file selects shared state", true],
    ["unreadable environment file", true],
    ["unreadable optional environment file", true],
    ["account lookup fails", true],
    ["malformed account record", true],
    ["unreadable service state", true],
    ["manager supplies shared state", true],
    ["pass environment can select shared state", true],
    ["private bind mount selects shared state", true],
    ["service root remaps state", true],
    ["PAM can select shared state", true],
    ["namespace inspection fails", true],
  ] as const)("%s", async (scenario, refuses) => {
    const stateDir = path.join(callerHome, ".openclaw");
    if (scenario === "manager supplies shared state") {
      managerEnvironment = [`OPENCLAW_STATE_DIR=${stateDir}`];
    }
    if (scenario === "pass environment can select shared state") {
      serviceOverrides.PassEnvironment = property("as", ["OPENCLAW_STATE_DIR"]);
    }
    if (scenario === "private bind mount selects shared state") {
      serviceOverrides.BindPaths = property("a(ssbt)", [
        [stateDir, path.join(serviceHome, ".openclaw"), false, 0],
      ]);
    }
    if (scenario === "service root remaps state") {
      serviceOverrides.RootDirectory = property("s", serviceHome);
    }
    if (scenario === "PAM can select shared state") {
      serviceOverrides.PAMName = property("s", "fixture-login");
    }
    isolationUnavailable = scenario === "namespace inspection fails";
    if (scenario === "shared account home") {
      serviceHome = callerHome;
    }
    if (scenario === "explicit shared state") {
      assignments = [`OPENCLAW_STATE_DIR=${stateDir}`];
    }
    if (scenario === "explicit separate state") {
      assignments = [`OPENCLAW_STATE_DIR=${serviceHome}`];
    }
    if (scenario === "relative shared state") {
      assignments = ["OPENCLAW_STATE_DIR=../caller/.openclaw"];
    }
    if (scenario === "symlink to shared state") {
      await fs.mkdir(stateDir);
      await fs.symlink(stateDir, path.join(serviceHome, ".openclaw"));
    }
    if (scenario === "hard link to shared database") {
      const callerDatabase = path.join(stateDir, "state", "openclaw.sqlite");
      const serviceDatabase = path.join(serviceHome, ".openclaw", "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(callerDatabase), { recursive: true });
      await fs.mkdir(path.dirname(serviceDatabase), { recursive: true });
      await fs.writeFile(callerDatabase, "");
      await fs.link(callerDatabase, serviceDatabase);
    }
    if (scenario.includes("environment file")) {
      const file = path.join(serviceHome, "gateway.env");
      fileSpecs = [[file, scenario.includes("optional")]];
      assignments = [`HOME=${serviceHome}`];
      await fs.writeFile(file, `OPENCLAW_STATE_DIR=${stateDir}\n`);
      if (scenario.startsWith("unreadable")) {
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (candidate, ...args) => {
          if (candidate === file) {
            throw Object.assign(new Error("unreadable fixture"), { code: "EACCES" });
          }
          return readFile(candidate, ...args);
        });
      }
    }
    if (scenario === "account lookup fails") {
      native.exec.mockRejectedValue(new Error("getent unavailable"));
    }
    if (scenario === "malformed account record") {
      native.exec.mockResolvedValue(nativeExit("wrong:x:2002:2002::relative:/bin/sh\n"));
    }
    if (scenario === "unreadable service state") {
      assignments = [`HOME=${serviceHome}`];
      const realpath = fs.realpath;
      vi.spyOn(fs, "realpath").mockImplementation(async (candidate, ...args) => {
        if (candidate.toString().startsWith(serviceHome)) {
          throw Object.assign(new Error("unreadable fixture"), { code: "EACCES" });
        }
        return realpath(candidate, ...args);
      });
    }
    const installation = await inspectCliGatewayServiceInstallation({ HOME: callerHome });
    expect(installation).toBeDefined();
    withGatewayServiceInstallation({ installation }, () => {
      const migrate = () =>
        assertGatewayServiceSchemaMigrationAllowed(
          path.join(stateDir, "state", "openclaw.sqlite"),
          1,
          2,
        );
      if (refuses) {
        expect(migrate).toThrow("Refusing a forward database schema migration");
      } else {
        expect(migrate).not.toThrow();
      }
    });
  });
});
