import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const systemUnitDirectories = vi.hoisted((): string[] => []);
const systemBus = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/systemd-exec.js").execBusctlSystem>(),
);
const userBus = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/systemd-exec.js").execBusctlUser>(),
);
const systemctl = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/systemd-exec.js").execSystemctl>(),
);
const ownGatewayInvocation = vi.hoisted(() =>
  vi.fn<typeof import("./gateway-run-argv.js").isGatewayRunInvocationArgv>(() => false),
);
const forbiddenSpawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected real child_process.spawn call");
  }),
);
const forbiddenExecFile = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected real child_process.execFile call");
  }),
);

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: forbiddenExecFile,
  spawn: forbiddenSpawn,
}));
vi.mock("../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-exec.js")>()),
  execBusctlSystem: systemBus,
  execBusctlUser: userBus,
  execSystemctl: systemctl,
}));
vi.mock("../daemon/systemd-unit-load-paths.js", async (original) => ({
  ...(await original<typeof import("../daemon/systemd-unit-load-paths.js")>()),
  DEFAULT_SYSTEMD_SYSTEM_UNIT_DIRS: systemUnitDirectories,
}));
vi.mock("./gateway-run-argv.js", async (original) => ({
  ...(await original<typeof import("./gateway-run-argv.js")>()),
  isGatewayRunInvocationArgv: ownGatewayInvocation,
}));

import { nativeExit } from "../daemon/systemd-exec.test-support.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { withGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertGatewayServiceSchemaMigrationAllowed } from "../state/openclaw-state-service-installation.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { inspectCliGatewayServiceInstallation } from "./run-main-service-installation.js";

type SystemFixture = {
  assignments: string[];
  entrypoint: string;
  serviceUser: string;
  unitName: string;
  unitPath: string;
  workingDirectory: string;
};

type PreparedScenario = {
  accountHome: string;
  callerDatabasePath: string;
  callerHome: string;
  env: NodeJS.ProcessEnv;
};

type ScenarioOptions = {
  accountHomeName: string;
  callerHomeName: string;
  serviceStateDirName?: string;
  serviceUser: string;
};

type OwnedScenarioResult = PreparedScenario | { skipReason: string };

const dirs = useAutoCleanupTempDirTracker(afterEach);
let systemFixture: SystemFixture | undefined;

const CHOWN_CAPABILITY_ERRORS = new Set([
  "EACCES",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

const property = (type: string, data: unknown) => ({ type, data });
const reply = (type: string, data: unknown) => nativeExit(JSON.stringify(property(type, data)));

function requireSystemFixture(): SystemFixture {
  if (!systemFixture) {
    throw new Error("Systemd fixture was not prepared");
  }
  return systemFixture;
}

async function systemBusResponse(args: string[]) {
  const fixture = requireSystemFixture();
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
    expect(args.at(-1)).toBe(fixture.unitName);
    return reply("o", ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"]);
  }
  const properties: Record<string, unknown> = {
    FragmentPath: property("s", fixture.unitPath),
    DropInPaths: property("as", []),
    NeedDaemonReload: property("b", false),
    LoadState: property("s", "loaded"),
    UnitFileState: property("s", "enabled"),
    ActiveState: property("s", "active"),
    CanStart: property("b", true),
    RefuseManualStart: property("b", false),
    ExecStart: property("a(sasbttttuii)", [
      [
        process.execPath,
        [process.execPath, fixture.entrypoint, "gateway"],
        false,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ],
    ]),
    WorkingDirectory: property("s", fixture.workingDirectory),
    Environment: property("as", fixture.assignments),
    EnvironmentFiles: property("a(sb)", []),
    UnsetEnvironment: property("as", []),
    User: property("s", fixture.serviceUser),
  };
  const index = args.findIndex((argument) => /\.(Unit|Service)$/u.test(argument));
  if (index < 0) {
    throw new Error("Unexpected system manager query");
  }
  return nativeExit(
    args
      .slice(index + 1)
      .map((name) => JSON.stringify(properties[name]))
      .join("\n"),
  );
}

function mockCallerAccount(username: string, uid: number, homedir: string): void {
  vi.spyOn(os, "userInfo").mockReturnValue({
    username,
    uid,
    gid: uid,
    homedir,
    shell: "/bin/sh",
  });
  if (typeof process.getuid === "function") {
    vi.spyOn(process, "getuid").mockReturnValue(uid);
  }
  if (typeof process.geteuid === "function") {
    vi.spyOn(process, "geteuid").mockReturnValue(uid);
  }
}

beforeEach(() => {
  mockProcessPlatform("linux");
  ownGatewayInvocation.mockReset().mockReturnValue(false);
  systemBus.mockReset().mockImplementation(systemBusResponse);
  userBus.mockReset().mockRejectedValue(new Error("Unexpected user systemd bus query"));
  systemctl.mockReset().mockRejectedValue(new Error("Unexpected systemctl call"));
  forbiddenSpawn.mockClear();
  forbiddenExecFile.mockClear();
  systemFixture = undefined;
});

afterEach(() => {
  try {
    expect(forbiddenSpawn).not.toHaveBeenCalled();
    expect(forbiddenExecFile).not.toHaveBeenCalled();
    expect(userBus).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
  } finally {
    systemFixture = undefined;
    vi.restoreAllMocks();
  }
});

function chownSkipReason(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return code && CHOWN_CAPABILITY_ERRORS.has(code)
    ? `root fixture cannot chown the temporary HOME (${code})`
    : undefined;
}

async function prepareScenario(options: ScenarioOptions) {
  const root = dirs.make("openclaw-systemd-account-");
  const accountHome = path.join(root, options.accountHomeName);
  const callerHome = path.join(root, options.callerHomeName);
  const serviceStateDir = options.serviceStateDirName
    ? path.join(root, options.serviceStateDirName)
    : undefined;
  const directories = [accountHome, callerHome];
  if (serviceStateDir) {
    directories.push(serviceStateDir);
  }
  await Promise.all(
    [...new Set(directories)].map((directory) => fsPromises.mkdir(directory, { recursive: true })),
  );

  const packageRoot = path.join(root, "older-package");
  const entrypoint = path.join(packageRoot, "openclaw.mjs");
  await fsPromises.mkdir(packageRoot);
  await Promise.all([
    fsPromises.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","version":"2026.7.1"}',
    ),
    fsPromises.writeFile(entrypoint, ""),
  ]);

  const systemUnitDirectory = path.join(root, "systemd-system");
  await fsPromises.mkdir(systemUnitDirectory);
  const unitName = "openclaw-gateway.service";
  const unitPath = path.join(systemUnitDirectory, unitName);
  await fsPromises.writeFile(
    unitPath,
    `[Service]\nExecStart=${process.execPath} ${entrypoint} gateway\n`,
  );
  systemUnitDirectories.splice(0, systemUnitDirectories.length, systemUnitDirectory);
  systemFixture = {
    assignments: serviceStateDir ? [`OPENCLAW_STATE_DIR=${serviceStateDir}`] : [],
    entrypoint,
    serviceUser: options.serviceUser,
    unitName,
    unitPath,
    workingDirectory: packageRoot,
  };

  const env: NodeJS.ProcessEnv = {
    HOME: callerHome,
  };
  if (serviceStateDir) {
    env.OPENCLAW_STATE_DIR = serviceStateDir;
  }
  const callerDatabasePath = resolveIdentityPathViaExistingAncestorSync(
    resolveOpenClawStateSqlitePath(env),
  );
  return { accountHome, callerDatabasePath, callerHome, env };
}

async function prepareOwnedCallerScenario(options: ScenarioOptions): Promise<OwnedScenarioResult> {
  const prepared = await prepareScenario(options);
  if (process.getuid?.() === 0) {
    try {
      fs.chownSync(prepared.callerHome, 65534, 65534);
    } catch (error) {
      const skipReason = chownSkipReason(error);
      if (skipReason) {
        return { skipReason };
      }
      throw error;
    }
  }
  const uid = fs.statSync(prepared.callerHome).uid;
  mockCallerAccount("caller", uid, prepared.accountHome);
  return prepared;
}

async function reportOwnershipFor(directory: string, uid: number): Promise<void> {
  const target = resolveIdentityPathViaExistingAncestorSync(directory);
  const stat = fsPromises.stat.bind(fsPromises);
  vi.spyOn(fsPromises, "stat").mockImplementation(async (candidate) => {
    const stats = await stat(candidate);
    if (path.resolve(candidate.toString()) === target) {
      Object.defineProperty(stats, "uid", { value: uid });
    }
    return stats;
  });
}

type ScenarioKind =
  | "foreign-isolated-home"
  | "foreign-default-home"
  | "foreign-state-owned-by-another-uid"
  | "same-account"
  | "explicit-state"
  | "root-service-home"
  | "root-owned-service-home"
  | "other-non-root";

async function prepareTestScenario(kind: ScenarioKind): Promise<OwnedScenarioResult> {
  if (kind === "foreign-isolated-home") {
    return prepareOwnedCallerScenario({
      accountHomeName: "caller-home",
      callerHomeName: "isolated",
      serviceUser: "openclaw-svc",
    });
  }
  if (kind === "foreign-default-home") {
    return prepareOwnedCallerScenario({
      accountHomeName: "caller-home",
      callerHomeName: "caller-home",
      serviceUser: "openclaw-svc",
    });
  }
  if (kind === "foreign-state-owned-by-another-uid") {
    const prepared = await prepareOwnedCallerScenario({
      accountHomeName: "caller-home",
      callerHomeName: "caller-home",
      serviceUser: "openclaw-svc",
    });
    if ("skipReason" in prepared) {
      return prepared;
    }
    const stateDirectory = path.dirname(prepared.callerDatabasePath);
    await fsPromises.mkdir(stateDirectory, { recursive: true });
    const owner = fs.statSync(prepared.callerHome).uid;
    await reportOwnershipFor(stateDirectory, owner + 1);
    return prepared;
  }
  if (kind === "same-account") {
    return prepareOwnedCallerScenario({
      accountHomeName: "caller-home",
      callerHomeName: "caller-home",
      serviceUser: "caller",
    });
  }
  if (kind === "explicit-state") {
    return prepareOwnedCallerScenario({
      accountHomeName: "caller-home",
      callerHomeName: "isolated",
      serviceStateDirName: "shared-state",
      serviceUser: "openclaw-svc",
    });
  }
  if (kind === "root-service-home" || kind === "root-owned-service-home") {
    const prepared = await prepareScenario({
      accountHomeName: "root-home",
      callerHomeName: "svc-home",
      serviceUser: "openclaw-svc",
    });
    if (kind === "root-owned-service-home") {
      await reportOwnershipFor(prepared.callerHome, 0);
    }
    mockCallerAccount("root", 0, prepared.accountHome);
    return prepared;
  }
  const prepared = await prepareScenario({
    accountHomeName: "other-home",
    callerHomeName: "svc-home",
    serviceUser: "openclaw-svc",
  });
  const owner = fs.statSync(prepared.callerHome).uid;
  const uid = owner + 1;
  mockCallerAccount("other", uid, prepared.accountHome);
  return prepared;
}

const scenarios: Array<{
  kind: ScenarioKind;
  name: string;
  refusesMigration: boolean;
}> = [
  {
    kind: "foreign-isolated-home",
    name: "allows isolated caller HOME for a foreign service account",
    refusesMigration: false,
  },
  {
    kind: "foreign-default-home",
    name: "allows default caller HOME for a foreign service account",
    refusesMigration: false,
  },
  {
    kind: "foreign-state-owned-by-another-uid",
    name: "refuses state directory owned by another UID",
    refusesMigration: true,
  },
  {
    kind: "same-account",
    name: "refuses same-account service state migration",
    refusesMigration: true,
  },
  {
    kind: "explicit-state",
    name: "refuses explicit service state directory migration",
    refusesMigration: true,
  },
  {
    kind: "root-service-home",
    name: "refuses root caller carrying service account HOME migration",
    refusesMigration: true,
  },
  {
    kind: "root-owned-service-home",
    name: "refuses root-owned service account HOME migration",
    refusesMigration: true,
  },
  {
    kind: "other-non-root",
    name: "refuses other non-root caller using service account HOME migration",
    refusesMigration: true,
  },
];

describe.skipIf(process.platform === "win32")("systemd account service installation", () => {
  it.for(scenarios)("$name", async ({ kind, refusesMigration }, context) => {
    const prepared = await prepareTestScenario(kind);
    if ("skipReason" in prepared) {
      context.skip(prepared.skipReason);
      return;
    }
    const installation = await inspectCliGatewayServiceInstallation(prepared.env);

    const migrate = () =>
      withGatewayServiceInstallation({ installation }, () =>
        assertGatewayServiceSchemaMigrationAllowed(prepared.callerDatabasePath, 1, 2),
      );
    if (refusesMigration) {
      expect(migrate).toThrow("Refusing a forward database schema migration");
    } else {
      expect(migrate).not.toThrow();
    }
  });
});
