import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import { execFileUtf8 } from "./exec-file.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { resolveManagedGatewayServiceCommand } from "./service-types.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import { stageSystemdService } from "./systemd-install.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
// Native responses are fixtures; no host service manager or runtime probe is contacted.
vi.mock("./systemd-user-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-user-transport.js")>()),
  resolveSystemdUserTransport: vi.fn(async () => undefined),
}));
vi.mock("./runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-paths.js")>()),
  resolveSystemNodeInfo: vi.fn(async () => null),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(execFileUtf8).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32").each(["api_key", "token"] as const)(
  "delivers %s auth-profile credentials through the owner-only env file across reinstall",
  async (type) => {
    const home = await fs.realpath(tempDirs.make("systemd-auth-profile-secret-"));
    const stateDir = path.join(home, "state");
    const env = { HOME: home, OPENCLAW_STATE_DIR: stateDir };
    const key = "OPENCLAW_CUSTOM_PROVIDER_CREDENTIAL";
    const value = "synthetic-provider-credential";
    const wrapperPath = path.join(home, "openclaw-wrapper");
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const authStore = {
      version: 1,
      profiles: {
        "custom:default": {
          type,
          provider: "custom",
          ...(type === "api_key"
            ? { keyRef: { source: "env" as const, provider: "default", id: key } }
            : { tokenRef: { source: "env" as const, provider: "default", id: key } }),
        },
      },
    };
    const unitPath = resolveSystemdUnitPath(env);
    const envFilePath = resolveSystemdEnvironmentFilePath({ stateDir });
    const programArguments = [wrapperPath, "gateway", "--port", "18789"];
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(stateDir, { mode: 0o700 });
    await fs.writeFile(
      unitPath,
      buildSystemdUnit({ programArguments, environment: { ...env, [key]: value } }),
      { mode: 0o644 },
    );
    mockSystemdManagerSnapshot({
      programArguments,
      fragmentPath: unitPath,
      environment: [`${key}=${value}`],
      environmentFiles: [],
    });
    let installed: Awaited<ReturnType<typeof readSystemdServiceExecStart>> = null;
    for (const callerEnvironment of [{ ...env, [key]: value }, env]) {
      const plan = await buildGatewayInstallPlan({
        env: callerEnvironment,
        port: 18789,
        runtime: "node",
        runtimePath: "/usr/bin/node",
        platform: "linux",
        wrapperPath,
        authStore,
        existingEnvironment: installed?.environment,
        existingEnvironmentValueSources: installed?.environmentValueSources,
      });
      expect(plan.environmentValueSources?.[key]).toBe("file");
      await stageSystemdService({ env, stdout: new PassThrough(), ...plan });
      const unit = await fs.readFile(unitPath, "utf8");
      expect(unit).not.toContain(`${key}=`);
      expect(unit).not.toContain(value);
      expect(await fs.readFile(`${unitPath}.bak`, "utf8")).not.toContain(value);
      expect(unit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect((await fs.stat(envFilePath)).mode & 0o777).toBe(0o600);
      mockSystemdManagerSnapshot({
        programArguments: plan.programArguments,
        fragmentPath: unitPath,
        environment: Object.entries(plan.environment).flatMap(([name, entry]) =>
          entry === undefined || name === key ? [] : [`${name}=${entry}`],
        ),
        environmentFiles: [[envFilePath, false]],
      });
      installed = expectDefined(await readSystemdServiceExecStart(env), "installed service");
      expect(installed.environment?.[key]).toBe(value);
      expect(installed.environmentValueSources?.[key]).toBe("file");
    }
  },
);

function mockSystemdManagerSnapshot(
  snapshot: SystemdManagerSnapshotFixture & { fragmentPath: string },
) {
  vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
    let stdout: string;
    if (command === "busctl" && (args.includes("LoadUnit") || args.includes("GetUnit"))) {
      stdout = JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] });
    } else if (command === "busctl" && args.includes("org.freedesktop.systemd1.Unit")) {
      stdout = buildSystemdUnitPropertyOutput(snapshot);
    } else if (command === "busctl" && args.includes("org.freedesktop.systemd1.Service")) {
      stdout = buildSystemdManagerPropertyOutput(snapshot);
    } else if (command === "systemctl" && args.includes("--property=LoadState")) {
      stdout = "not-found";
    } else if (command === "systemctl" && args.includes("--property=UnitPath")) {
      stdout = path.join(path.dirname(snapshot.fragmentPath), "absent-system-units");
    } else if (command === "systemctl" && args[0] === "--user" && args[1] === "show") {
      stdout =
        "After=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nLoadState=loaded\nTimeoutStopUSec=330s\nDelegate=yes\nDelegateSubgroup=gateway\n";
    } else if (command === "systemctl" && args[0] === "--user" && args[1] === "status") {
      stdout = "";
    } else {
      throw new Error(`Unexpected native fixture request: ${command} ${args.join(" ")}`);
    }
    return { code: 0, termination: "exit", stdout, stderr: "" };
  });
}

it.skipIf(process.platform === "win32").each([
  { source: "EnvironmentFile", servicePath: "/usr/local/bin:/usr/bin:/bin" },
  { source: "Environment", servicePath: "/usr/local/bin:/opt/operator/bin:/usr/bin:/bin" },
])(
  "preserves operator $source settings across audited reinstall",
  async ({ source, servicePath: systemPath }) => {
    const home = await fs.realpath(tempDirs.make("systemd-environment-preservation-"));
    const servicePath = `/opt/openclaw-runtime/bin:${systemPath}:${home}/.local/bin:${home}/.npm-global/bin:${home}/bin:${home}/.nix-profile/bin`;
    const stateDir = path.join(home, "state");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-environment-proof",
    };
    const unitPath = resolveSystemdUnitPath(env);
    await fs.mkdir(stateDir, { mode: 0o700 });
    await fs.mkdir(`${unitPath}.d`, { recursive: true, mode: 0o700 });
    const wrapperPath = path.join(stateDir, "openclaw-wrapper");
    const dropInPath = `${unitPath}.d/operator.conf`;
    const operatorFile = path.join(stateDir, "operator.env");
    const operatorKey = "OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS";
    const operatorValue = "120000";
    const base = {
      programArguments: [wrapperPath, "gateway", "--port", "18789"],
      environment: {
        ...env,
        OPENCLAW_SYSTEMD_UNIT: `${env.OPENCLAW_SYSTEMD_UNIT}.service`,
        PATH: servicePath,
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: operatorKey,
      },
    };
    const dropIn = `[Service]\n${source}=${source === "EnvironmentFile" ? operatorFile : `${operatorKey}=${operatorValue}`}\n`;
    await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(unitPath, buildSystemdUnit(base), { mode: 0o600 });
    await fs.writeFile(dropInPath, dropIn, { mode: 0o600 });
    if (source === "EnvironmentFile") {
      await fs.writeFile(operatorFile, `${operatorKey}=${operatorValue}\n`, { mode: 0o600 });
    }
    const snapshot = (config: {
      programArguments: string[];
      environment: Record<string, string | undefined>;
    }): SystemdManagerSnapshotFixture & { fragmentPath: string } => ({
      programArguments: config.programArguments,
      fragmentPath: unitPath,
      dropInPaths: [dropInPath],
      environment: [
        ...Object.entries(config.environment).flatMap(([key, value]) =>
          value === undefined ? [] : [`${key}=${value}`],
        ),
        ...(source === "Environment" ? [`${operatorKey}=${operatorValue}`] : []),
      ],
      environmentFiles: source === "EnvironmentFile" ? [[operatorFile, false]] : [],
    });
    mockSystemdManagerSnapshot(snapshot(base));
    const command = expectDefined(
      await readSystemdServiceExecStart(env, { requireEffective: true }),
      "effective service command",
    );
    expect(command.environment?.[operatorKey]).toBe(operatorValue);
    expect(command.managedOverrides?.environment).toEqual({ keys: [operatorKey] });
    const managed = expectDefined(resolveManagedGatewayServiceCommand(command), "managed base");
    expect(managed.environment?.[operatorKey]).toBeUndefined();
    const plan = await buildGatewayInstallPlan({
      env,
      port: 18789,
      runtime: "node",
      platform: "linux",
      runtimePath: "/opt/openclaw-runtime/bin/node",
      wrapperPath,
      existingCommand: command,
      existingEnvironment: managed.environment,
      existingEnvironmentValueSources: managed.environmentValueSources,
      authStore: { version: 1, profiles: {} },
    });
    expect(plan.environment.PATH).toBe(servicePath);
    const audit = await auditGatewayServiceConfig({
      env,
      command,
      expectedCommand: plan,
      expectedServicePath: plan.environment.PATH,
      platform: "linux",
    });
    expect(audit.definitionDriftError).toBeUndefined();
    expect(audit.definitionDrift).toBeUndefined();
    expect(audit.issues).toEqual([]);
    expect(plan.environment[operatorKey]).toBeUndefined();

    await stageSystemdService({ env, stdout: new PassThrough(), ...plan });
    const rewrittenUnit = await fs.readFile(unitPath, "utf8");
    expect(rewrittenUnit).not.toContain(operatorKey);
    await expect(fs.readFile(dropInPath, "utf8")).resolves.toBe(dropIn);
    if (source === "EnvironmentFile") {
      await expect(fs.readFile(operatorFile, "utf8")).resolves.toBe(
        `${operatorKey}=${operatorValue}\n`,
      );
    }
    mockSystemdManagerSnapshot(snapshot(plan));
    const rewritten = await readSystemdServiceExecStart(env, { requireEffective: true });
    expect(rewritten?.environment?.[operatorKey]).toBe(operatorValue);
    expect(rewritten?.managedDefinition?.environment?.[operatorKey]).toBeUndefined();
    expect(rewritten?.managedDefinition?.environment?.PATH).toBe(plan.environment.PATH);
  },
);
