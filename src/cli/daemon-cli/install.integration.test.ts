import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import type {
  GatewayService,
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { buildSystemdUnit, parseSystemdExecStart } from "../../daemon/systemd-unit.js";
import { systemdManagerVersionProbe } from "../../daemon/systemd-user-bus.test-support.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { captureFullEnv, withEnvAsync } from "../../test-utils/env.js";
import { expectText } from "../../test-utils/text-assertions.js";
import { stubNodeRuntime } from "../update-cli/update-command-runtime-recovery.test-support.js";
import { nativeResult } from "../update-cli/update-command-service-fixtures.test-support.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import type { DaemonInstallOptions } from "./types.js";

const tokenConfig = (token?: string) => ({
  gateway: { auth: { mode: "token", ...(token ? { token } : {}) } },
});

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } = await vi.hoisted(
  async () => {
    const { createCliRuntimeCapture } = await import("../test-runtime-capture.js");
    return createCliRuntimeCapture();
  },
);
const busctl = vi.hoisted(() =>
  vi.fn<typeof import("../../daemon/systemd-exec.js").execBusctlUser>(),
);
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execBusctlUser: busctl,
}));
vi.mock("../../daemon/systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));

const serviceMock = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn(async (_opts?: GatewayServiceInstallArgs) => {}),
  isLoaded: vi.fn(async () => false),
  readDefinitionMutationCapability: vi.fn<
    NonNullable<GatewayService["readDefinitionMutationCapability"]>
  >(async () => ({ kind: "writable" })),
  readCommand: vi.fn<
    typeof import("../../daemon/systemd-service-files.js").readSystemdServiceExecStart
  >(async () => null),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => serviceMock,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime,
}));

const runtimePinState = await import("../../daemon/runtime-pin-state.js");
const runtimePaths = await import("../../daemon/runtime-paths.js");

const daemonExec = await import("../../daemon/exec-file.js");
const { runDaemonInstall } = await import("./install.js");
const { clearConfigCache, clearRuntimeConfigSnapshot, readConfigFileSnapshot } =
  await import("../../config/config.js");
const { readSystemdDefinitionMutationCapability } =
  await import("../../daemon/systemd-definition-mutation.js");
const { readSystemdServiceExecStart, resolveSystemdServiceName, resolveSystemdUnitPath } =
  await import("../../daemon/systemd-service-files.js");

const userSystemdTarget = (env: NodeJS.ProcessEnv) => ({
  scope: "user" as const,
  unitName: `${resolveSystemdServiceName(env)}.service`,
  unitPath: resolveSystemdUnitPath(env),
});

// These fixtures author a user unit; do not discover real system units on the test host.
const readUserSystemdServiceExecStart: typeof readSystemdServiceExecStart = (env, options) =>
  readSystemdServiceExecStart(env, {
    ...options,
    systemdReadTarget: userSystemdTarget(env),
  });

async function writePrivateFile(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, contents, { mode: 0o600 });
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function createInstalledServiceCommand() {
  // An installed service has already observed its config; include that health store in snapshots.
  await readConfigFileSnapshot();
  const programArguments = ["openclaw", "gateway", "run"];
  const environment = buildServiceEnvironment({
    env: process.env,
    port: 18789,
    execPath: programArguments[0],
  });
  return {
    programArguments,
    // Service readers return only persisted strings, including the host's required TLS CA bundle.
    environment: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

describe("runDaemonInstall integration", () => {
  let envSnapshot: ReturnType<typeof captureFullEnv>;
  let accountHome: string;
  let tempHome: string;
  let configPath: string;
  let originalArgv: string[];

  async function writeConfig(config: unknown, indent?: number) {
    await fs.writeFile(configPath, JSON.stringify(config, null, indent));
    clearConfigCache();
  }

  async function snapshotConfig() {
    const contents = await fs.readFile(configPath);
    const { ino, mode, uid } = await fs.lstat(configPath);
    return { contents, ino, mode, uid, entries: (await fs.readdir(tempHome)).toSorted() };
  }

  async function preparedSnapshotConfig() {
    // Prime only the baseline; post-action observations must never repair state.
    await runtimePinState.withDaemonRuntimePinMigration(process.env, () => undefined);
    return snapshotConfig();
  }

  async function expectPreservedConfig(
    before: Awaited<ReturnType<typeof snapshotConfig>>,
    message: string,
    options: DaemonInstallOptions = { json: true, force: true },
  ) {
    await expect(runDaemonInstall(options)).rejects.toThrow("__exit__:1");
    expect(runtimeLogs.join("\n")).toContain(message);
    expectNoCalls(serviceMock.install);
    expect(await snapshotConfig()).toEqual(before);
  }

  afterEach(async () => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    envSnapshot.restore();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(accountHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    originalArgv = process.argv;
    envSnapshot = captureFullEnv();
    accountHome = await makeTempWorkspace("openclaw-daemon-install-int-");
    tempHome = path.join(accountHome, ".openclaw");
    await fs.mkdir(tempHome, { mode: 0o700 });
    configPath = path.join(tempHome, "openclaw.json");
    process.env.HOME = accountHome;
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(accountHome, "bus")}`;
    process.env.OPENCLAW_STATE_DIR = tempHome;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    vi.clearAllMocks();
    mockSystemAccountHome();
    vi.spyOn(daemonExec, "execFileUtf8").mockImplementation(systemdManagerVersionProbe);
    resetRuntimeCapture();
    clearRuntimeConfigSnapshot();
    // Keep these defined-but-empty so dotenv won't repopulate from local .env.
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    serviceMock.isLoaded.mockResolvedValue(false);
    serviceMock.install.mockReset().mockResolvedValue(undefined);
    serviceMock.readDefinitionMutationCapability
      .mockReset()
      .mockResolvedValue({ kind: "writable" });
    serviceMock.readCommand.mockReset().mockResolvedValue(null);
    await writeConfig({}, 2);
  });

  it("migrates legacy runtime intent before planning and preserves a malformed pin", async () => {
    await writeConfig({ gateway: { mode: "local" } });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const identity = ["gateway", "linux", resolveSystemdServiceName(process.env), configPath];
    const key = `daemon-runtime-pin:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    writeConfigMachineState(key, { version: 99 });
    const command = { programArguments: [process.execPath, "/fixture/openclaw.mjs", "gateway"] };
    serviceMock.readCommand.mockResolvedValue(command);
    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");
    expect(readConfigMachineState(key)).toBeUndefined();
    expect(() =>
      runtimePinState.readDaemonRuntimePin({ kind: "gateway", env: process.env }, command),
    ).toThrow();
    expect(runtimeLogs.join("\n")).toContain("Runtime pin inspection failed");
    expect(serviceMock.install).not.toHaveBeenCalled();
  });

  it("repairs a non-executable Node in the Linux service definition", async () => {
    const { execPath: testNodeExecPath } = stubNodeRuntime();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const entry = path.join(tempHome, "dist", "index.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "");
    const oldNode = path.join(accountHome, ".hermes-non-executable", "node", "bin", "node");
    await fs.mkdir(path.dirname(oldNode), { recursive: true });
    await fs.writeFile(oldNode, "not executable\n", { mode: 0o600 });
    const definitionPath = path.join(tempHome, "gateway.service");
    const readDefinition = async (): Promise<GatewayServiceCommandConfig> => {
      const unit = await fs.readFile(definitionPath, "utf8");
      const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
      if (!execStart) {
        throw new Error("Missing systemd command");
      }
      return {
        programArguments: parseSystemdExecStart(execStart.slice("ExecStart=".length)),
        sourcePath: definitionPath,
      };
    };
    await fs.writeFile(
      definitionPath,
      buildSystemdUnit({ programArguments: [oldNode, entry, "gateway"] }),
    );
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockImplementation(readDefinition);
    serviceMock.install.mockImplementationOnce(async (plan) => {
      if (!plan) {
        throw new Error("Missing install plan");
      }
      await fs.writeFile(
        definitionPath,
        buildSystemdUnit({ programArguments: plan.programArguments }),
      );
    });
    process.argv = [process.execPath, entry];
    await runDaemonInstall({ json: true, force: true });
    expect(serviceMock.install).toHaveBeenCalledOnce();
    const repaired = await readDefinition();
    const nodePath = repaired.programArguments[0];
    if (!nodePath) {
      throw new Error("Missing repaired runtime");
    }
    expect(await fs.realpath(nodePath)).toBe(await fs.realpath(testNodeExecPath));
    expect(repaired.programArguments).toContain(entry);
    expect(await fs.readFile(definitionPath, "utf8")).not.toContain(oldNode);
    expect(runtimeLogs.join("\n")).toContain(`Replacing missing Gateway service Node (${oldNode})`);
  });

  it.each([
    { mode: "external supervision", reason: "managed by an external supervisor" },
    { mode: "relocated home", reason: "non-default state dir or config path" },
    { mode: "sudo user manager", reason: "Refusing a sudo-to-root" },
  ])("preserves config and skips native inspection for $mode", async ({ mode, reason }) => {
    // Keep the synthetic account fixed when the invocation relocates HOME.
    // Following that override would erase the ownership mismatch being tested.
    const account = os.userInfo();
    vi.spyOn(os, "homedir").mockReturnValue(accountHome);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...account, homedir: accountHome });
    if (mode === "sudo user manager") {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(os, "userInfo").mockReturnValue({
        ...account,
        username: "root",
        homedir: accountHome,
      });
      if (process.geteuid) {
        vi.spyOn(process, "geteuid").mockReturnValue(0);
      }
    }
    const before = await preparedSnapshotConfig();
    await withEnvAsync(
      {
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_SUPERVISOR_MODE: mode.includes("supervision") ? " ExTeRnAl " : undefined,
        HOME: mode === "relocated home" ? path.join(accountHome, "relocated") : accountHome,
        SUDO_USER: mode === "sudo user manager" ? "service-fixture" : undefined,
      },
      async () => {
        await expectPreservedConfig(before, reason, { json: true });
        expectNoCalls(
          serviceMock.isLoaded,
          serviceMock.readCommand,
          serviceMock.readDefinitionMutationCapability,
        );
      },
    );
  });

  it("explains unsafe publication permissions and recovers without bypassing SecretRefs", async () => {
    const fixture = await fs.realpath(
      await fs.mkdtemp(path.join(tempHome, "private-path-canary-")),
    );
    const ancestor = path.join(fixture, ".config");
    const config = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
      },
    };
    await fs.mkdir(ancestor);
    await fs.chmod(ancestor, 0o777);
    await writeConfig(config);
    busctl.mockResolvedValue(
      nativeResult("", 1, "Call failed: Unit openclaw-gateway.service not found."),
    );
    const env = { ...process.env, HOME: fixture, OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
    serviceMock.readCommand.mockImplementation((_env, options) =>
      readUserSystemdServiceExecStart(env, options),
    );
    serviceMock.readDefinitionMutationCapability.mockImplementation(() =>
      readSystemdDefinitionMutationCapability(env, {
        systemdReadTarget: userSystemdTarget(env),
      }),
    );
    const before = await preparedSnapshotConfig();
    await expect(runDaemonInstall({ json: false, force: true })).rejects.toThrow("__exit__:1");
    expect(await snapshotConfig()).toEqual(before);
    expect(await fs.readdir(ancestor)).toEqual([]);
    expect(serviceMock.install).not.toHaveBeenCalled();
    const output = [...runtimeLogs, ...runtimeErrors].join("\n");
    expectText(
      output,
      [
        "SERVICE_DEFINITION_UNKNOWN",
        "unsafe-permissions",
        "service directory",
        "group/world-writable",
        "chmod go-w",
      ],
      ["private-path-canary", "MISSING_GATEWAY_TOKEN"],
    );

    await fs.chmod(ancestor, 0o700);
    resetRuntimeCapture();
    await expect(runDaemonInstall({ json: false, force: true })).rejects.toThrow("__exit__:1");
    const recovered = [...runtimeLogs, ...runtimeErrors].join("\n");
    expect(recovered).not.toContain("SERVICE_DEFINITION_UNKNOWN");
    expect(recovered).toContain("SecretRef is configured but unresolved");
    expect((await readJson(configPath)).gateway).toEqual({ ...config.gateway, mode: "local" });
    expect(await fs.readdir(ancestor)).toEqual([]);
    expect(serviceMock.install).not.toHaveBeenCalled();
  });

  it("names an unreadable Linux unit without changing config or replacing it", async () => {
    const unit = path.join(accountHome, ".config/systemd/user/openclaw-gateway.service");
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (args[0] === unit) {
        throw Object.assign(new Error("private-native-error-canary"), { code: "EACCES" });
      }
      return readFile(...args);
    });
    serviceMock.readCommand.mockImplementation(readUserSystemdServiceExecStart);
    serviceMock.isLoaded.mockRejectedValue(new Error("Failed to get unit file state"));
    const before = await preparedSnapshotConfig();
    await expectPreservedConfig(before, "unreadable");
    const output = runtimeLogs.join("\n");
    expectText(output, [JSON.stringify(unit).slice(1, -1)], ["private-native-error-canary"]);
    expect(serviceMock.isLoaded).not.toHaveBeenCalled();
  });

  it("checks the planned generated environment after a drop-in redirects effective state", async () => {
    const fixture = await fs.realpath(await fs.mkdtemp(path.join(tempHome, "planned-owner-")));
    const plannedState = path.join(fixture, ".openclaw");
    const effectiveState = path.join(fixture, "effective");
    const unit = path.join(fixture, ".config/systemd/user/openclaw-gateway.service");
    const dropIn = `${unit}.d/override.conf`;
    const plannedFile = path.join(plannedState, "gateway.systemd.env");
    const effectiveFile = path.join(effectiveState, "gateway.systemd.env");
    await writePrivateFile(plannedFile, "OPERATOR_VALUE=planned\n");
    await writePrivateFile(effectiveFile, "OPERATOR_VALUE=effective\n");
    await writePrivateFile(
      unit,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironment=OPENCLAW_STATE_DIR=${plannedState}\nEnvironmentFile=${plannedFile}\n`,
    );
    await writePrivateFile(
      dropIn,
      `[Service]\nEnvironment=OPENCLAW_STATE_DIR=${effectiveState}\nEnvironmentFile=\nEnvironmentFile=${effectiveFile}\n`,
    );
    await fs.writeFile(configPath, JSON.stringify(tokenConfig("existing-token")));
    process.env.HOME = fixture;
    process.env.OPENCLAW_STATE_DIR = plannedState;
    process.env.OPENCLAW_CONFIG_PATH = path.join(plannedState, "openclaw.json");
    clearConfigCache();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === plannedFile) {
        Object.defineProperty(stat, "uid", { value: 0 });
      }
      return stat;
    });
    busctl.mockImplementation(async (_env, args) =>
      nativeResult(
        args.includes("LoadUnit")
          ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
          : args.includes("org.freedesktop.systemd1.Unit")
            ? buildSystemdUnitPropertyOutput({ fragmentPath: unit, dropInPaths: [dropIn] })
            : buildSystemdManagerPropertyOutput({
                programArguments: ["/usr/bin/node", "gateway"],
                environment: [`OPENCLAW_STATE_DIR=${effectiveState}`],
                environmentFiles: [[effectiveFile, false]],
              }),
      ),
    );
    serviceMock.readCommand.mockImplementation(readUserSystemdServiceExecStart);
    serviceMock.readDefinitionMutationCapability.mockImplementation((args) =>
      readSystemdDefinitionMutationCapability(args?.env ?? process.env, {
        environment: args?.environment,
      }),
    );
    const before = await preparedSnapshotConfig();
    await expectPreservedConfig(before, "SERVICE_DEFINITION_SEALED");
    expect((await fs.readdir(plannedState)).toSorted()).toEqual([
      "control",
      "gateway.systemd.env",
      "tmp",
    ]);
    expect(await fs.readdir(path.join(plannedState, "control"))).toEqual(["services.sqlite"]);
    expect(await fs.readdir(effectiveState)).toEqual(["gateway.systemd.env"]);
  });

  it("refuses service install when config was written by a newer OpenClaw", async () => {
    await writeConfig({ ...tokenConfig(), meta: { lastTouchedVersion: "9999.1.1" } }, 2);

    await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

    expect(serviceMock.install).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Refusing to install or rewrite the gateway service");
  });

  it.each(["auto-refresh", "effective state"] as const)(
    "refuses sealed %s before persisting config or a token",
    async (mode) => {
      const effective = mode === "effective state";
      const stateDir = path.join(tempHome, "sealed-service-state");
      await writeConfig(tokenConfig(effective ? undefined : "existing-token"));
      serviceMock.isLoaded.mockResolvedValue(true);
      serviceMock.readCommand.mockResolvedValue({
        programArguments: ["openclaw", "gateway", "run"],
        environment: effective
          ? { OPENCLAW_STATE_DIR: stateDir }
          : { OPENCLAW_GATEWAY_TOKEN: "outdated-token" },
      });
      serviceMock.readDefinitionMutationCapability.mockImplementationOnce(async (args) =>
        !effective || args?.environment?.OPENCLAW_STATE_DIR === stateDir
          ? { kind: "sealed", reason: "foreign-owner" }
          : { kind: "writable" },
      );
      if (!effective) {
        await readConfigFileSnapshot();
      }
      await expectPreservedConfig(await preparedSnapshotConfig(), "SERVICE_DEFINITION_SEALED", {
        json: true,
        force: effective,
      });
      if (effective) {
        expectPartialCall(serviceMock.readDefinitionMutationCapability, {
          env: expect.objectContaining({ OPENCLAW_STATE_DIR: tempHome }),
          environment: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
        });
      }
    },
  );

  it("preserves absent config and shared state while admitting local intent for rejected definition inspection", async () => {
    await fs.rm(configPath);
    clearConfigCache();
    const secret = "direct-install-capability-secret-canary";
    serviceMock.readDefinitionMutationCapability.mockRejectedValueOnce(new Error(secret));
    await expect(runDaemonInstall({ json: true, force: false })).rejects.toThrow("__exit__:1");
    expect((await fs.readdir(tempHome)).toSorted()).toEqual(["control", "tmp"]);
    expect(await fs.readdir(path.join(tempHome, "control"))).toEqual(["services.sqlite"]);
    await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(serviceMock.readCommand).toHaveBeenCalledOnce();
    expect(serviceMock.install).not.toHaveBeenCalled();
    expectText(runtimeLogs.join("\n"), ["SERVICE_DEFINITION_UNKNOWN"], [secret]);
  });

  it("auto-mints token when no source exists without embedding it into service env", async () => {
    await writeConfig(tokenConfig(), 2);
    serviceMock.isLoaded.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await runDaemonInstall({});

    expect(
      defaultRuntime.log.mock.calls.filter(([message]) =>
        String(message).includes("No gateway token found"),
      ),
    ).toEqual([["No gateway token found. Auto-generated one and saving to config."]]);
    expect(serviceMock.install).toHaveBeenCalledTimes(1);
    const updated = await readJson(configPath);
    const gateway = (updated.gateway ?? {}) as { auth?: { token?: string } };
    const persistedToken = gateway.auth?.token;
    expect(persistedToken).toEqual(expect.stringMatching(/^[0-9a-f]{48}$/));

    const installEnv = serviceMock.install.mock.calls[0]?.[0]?.environment;
    expect(installEnv?.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
  });
  describe("output", () => {
    beforeEach(() => {
      vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue({
        path: "/fixture/system/node",
        status: "supported",
        version: "26.8.2",
        sqliteVersion: "3.53.4",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      });
    });
    it.each(["transient-read", "validation"] as const)(
      "reports a saved runtime pin failure during %s without installing",
      async (failure) => {
        const runtimePath = path.join(tempHome, "missing", "node");
        serviceMock.readCommand.mockResolvedValue({
          programArguments: [runtimePath, "/opt/openclaw/openclaw.mjs", "gateway"],
        });
        const readRuntimePin = runtimePinState.readDaemonRuntimePinForInstall;
        const pinRead = vi.spyOn(runtimePinState, "readDaemonRuntimePinForInstall");
        if (failure === "transient-read") {
          pinRead.mockImplementation(() => {
            throw Object.assign(new Error("EIO: pin state read failed"), { code: "EIO" });
          });
        } else {
          pinRead.mockImplementation((...args) => ({
            ...readRuntimePin(...args),
            stored: true,
            pin: { runtime: "node", path: runtimePath },
          }));
        }

        await expect(runDaemonInstall({ json: true, force: true })).rejects.toThrow("__exit__:1");

        expect(pinRead).toHaveBeenCalledOnce();
        expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(1);
        const error =
          failure === "transient-read"
            ? "Runtime pin inspection failed: Error: EIO: pin state read failed"
            : `Invalid runtime pin: Error: Pinned runtime is not executable: ${runtimePath}; reinstall with an explicit --runtime or --runtime-path to replace the saved runtime pin.`;
        expect(runtimeLogs).toEqual([
          JSON.stringify({ action: "install", ok: false, error }, null, 2),
        ]);
        expect(runtimeErrors).toEqual([]);
        expect(serviceMock.install).not.toHaveBeenCalled();
      },
    );

    it("orders Gateway mode warning, installed result, and reinstall hint in plain text", async () => {
      await writeConfig(tokenConfig("existing-token"));
      serviceMock.isLoaded.mockResolvedValue(true);
      serviceMock.readCommand.mockResolvedValue(await createInstalledServiceCommand());

      await runDaemonInstall({ json: false });

      const warning = "No gateway.mode found. Set gateway.mode=local for managed gateway install.";
      const message = "Gateway service already loaded.";
      expect(runtimeLogs).toEqual([
        warning,
        message,
        "Reinstall with: openclaw gateway install --force",
      ]);
      expect(runtimeErrors).toEqual([]);
      expect(serviceMock.install).not.toHaveBeenCalled();
      expect((await readJson(configPath)).gateway).toEqual({
        mode: "local",
        auth: { mode: "token", token: "existing-token" },
      });
    });
  });
});
