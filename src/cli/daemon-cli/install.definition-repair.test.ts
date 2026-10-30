import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as installPlans from "../../commands/daemon-install-helpers.js";
import { maybeRepairGatewayServiceConfig } from "../../commands/doctor-gateway-services.js";
import { restoreDoctorGatewayService } from "../../commands/doctor-maintenance-restoration.js";
import { createDoctorPrompter } from "../../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../../config/config.js";
import { buildLaunchAgentPlist } from "../../daemon/launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "../../daemon/launchd-plist.test-support.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import { resolveGatewaySupervisorLogPaths } from "../../daemon/restart-logs.js";
import {
  GatewayServiceDefinitionBackupReceiptSchema,
  type GatewayServiceDefinitionBackupReceipt,
} from "../../daemon/service-stage.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { resolveSystemdUnitPath } from "../../daemon/systemd-service-files.js";
import {
  buildSystemdUnit,
  parseSystemdInlineEnvironment,
  parseSystemdExecStart,
} from "../../daemon/systemd-unit.js";
import { migrateDaemonRuntimePins } from "../../infra/state-migrations.daemon-runtime-pins.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { firstWrittenJsonArg } from "../test-runtime-capture.js";
import { stubNodeRuntime } from "../update-cli/update-command-runtime-recovery.test-support.js";
import { nativeResult } from "../update-cli/update-command-service-fixtures.test-support.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "../update-cli/update-command-service-plan.js";
import { runDaemonInstall } from "./install.js";

const native = vi.hoisted(() => ({
  root: "",
  source: "",
  command: vi.fn<() => Promise<GatewayServiceCommandConfig>>(),
  systemctl: vi.fn<typeof import("../../daemon/systemd-exec.js").execSystemctlUser>(),
  launchctl: vi.fn<typeof import("../../daemon/launchd-exec.js").execLaunchctl>(),
  serviceRuntime:
    vi.fn<typeof import("../../daemon/systemd-runtime.js").readSystemdServiceRuntime>(),
  note: vi.fn<(message: string, title?: string) => void>(),
  writeConfig: vi.fn<(config: OpenClawConfig) => Promise<OpenClawConfig>>(async (config) => config),
  config: {
    gateway: {
      mode: "local" as const,
      port: 19137,
      auth: { mode: "token" as const, token: "fixture-token" },
    },
  },
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn<(value: unknown) => void>(),
    exit: vi.fn((code: number) => {
      throw new Error(`fixture-exit:${code}`);
    }),
  },
}));
vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: native.note }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: native.runtime }));
vi.mock("../../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => native.root,
}));
vi.mock("../../config/io.js", async (original) => ({
  ...(await original<typeof import("../../config/io.js")>()),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { exists: true, valid: true, config: native.config, sourceConfig: native.config },
    writeOptions: {},
  }),
}));
vi.mock("../../daemon/runtime-paths.js", async (original) => ({
  ...(await original<typeof import("../../daemon/runtime-paths.js")>()),
  resolvePreferredNodePath: async () => process.execPath,
  resolveNodeRuntimeInfo: async () => ({
    status: "supported",
    path: process.execPath,
    version: process.versions.node,
    sqliteVersion: process.versions.sqlite,
  }),
  emitNodeRuntimeWarning: async () => {},
}));
vi.mock("../../daemon/systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: native.command,
}));
vi.mock("../../daemon/launchd-exec.js", async (original) => ({
  ...(await original<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: native.launchctl,
}));
vi.mock("../../daemon/launchd-runtime.js", async (original) => ({
  ...(await original<typeof import("../../daemon/launchd-runtime.js")>()),
  readLaunchAgentRuntime: native.serviceRuntime,
}));
vi.mock("../../daemon/launchd-current-service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/launchd-current-service.js")>()),
  isCurrentProcessInsideLaunchdService: async () => false,
}));
vi.mock("../../daemon/launchd-system.js", async (original) => ({
  ...(await original<typeof import("../../daemon/launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
}));
vi.mock("../../daemon/systemd-exec.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execSystemctlUser: native.systemctl,
}));
vi.mock("../../daemon/systemd-runtime.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-runtime.js")>()),
  isSystemdServiceEnabled: async () => true,
  readSystemdServiceRuntime: native.serviceRuntime,
}));
vi.mock("../../daemon/systemd-user-transport.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-user-transport.js")>()),
  resolveSystemdUserTransport: async () => undefined,
}));
vi.mock("../../daemon/exec-file.js", () => ({
  execFileUtf8: async (
    ...[command, args, options]: Parameters<typeof import("../../daemon/exec-file.js").execFileUtf8>
  ) => {
    if (
      command !== "systemctl" ||
      args.length !== 2 ||
      args[0] !== "--user" ||
      args[1] !== "daemon-reload"
    ) {
      throw new Error(`Unexpected native command in installer fixture: ${command}`);
    }
    const env = options?.env ?? {};
    expect(env.HOME).toBe(process.env.HOME);
    expect(resolveSystemdUnitPath(env)).toBe(native.source);
    return await native.systemctl(env, args.slice(1));
  },
}));
vi.mock("../../daemon/systemd-system.js", () => ({
  assertNoSystemSystemdOwnership: async () => {},
  isSystemSystemdOwnershipError: () => false,
}));
vi.mock("../../daemon/systemd-scope.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-scope.js")>()),
  assertNoSystemGatewayOwnership: async () => {},
  isSystemdServiceAbsent: async () => false,
  findSystemdGatewayInstallation: async () => ({
    kind: "user",
    user: { scope: "user", unitName: "openclaw-gateway.service", unitPath: native.source },
  }),
  findInstalledSystemdGatewayScope: async () => ({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: native.source,
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const read = (file: string) => fs.readFile(file, "utf8");
async function writeFixture(file: string, contents: string, mode?: number) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, contents, { mode });
}
const writeJson = (file: string, data: unknown) => writeFixture(file, JSON.stringify(data));
const install = () => runDaemonInstall({ force: true, json: true });
const systemctlCalls = (command: string) =>
  native.systemctl.mock.calls.filter(([, args]) => args[0] === command);
const runtime = (status: "running" | "stopped") => ({
  status,
  ...(status === "running" ? { pid: 4242 } : {}),
  systemd: { scope: "user" as const, managerUid: process.getuid?.() ?? 501 },
});
const buildPlan = (existingCommand?: GatewayServiceCommandConfig) =>
  installPlans.buildGatewayInstallPlan({
    env: process.env,
    port: 19137,
    runtime: "node",
    runtimePath: process.execPath,
    config: existingCommand ? { gateway: { mode: "local", port: 19137 } } : native.config,
    existingCommand,
    existingEnvironment: existingCommand?.environment,
  });
let originalEnv: NodeJS.ProcessEnv;
let originalArgv: string[];
beforeEach(() => {
  originalEnv = process.env;
  originalArgv = process.argv;
  vi.clearAllMocks();
  stubNodeRuntime();
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  process.env = originalEnv;
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function fixture(
  edit?: "ExecStartPre" | "foreign-unit" | "foreign-root" | "old-installation",
  layout: "direct" | "user-prefix shim" = "direct",
) {
  const home = await fs.realpath(dirs.make("candidate-service-repair-"));
  const state = path.join(home, ".openclaw");
  const cliBinDir = layout === "user-prefix shim" ? path.join(home, "npm", "bin") : undefined;
  native.root = cliBinDir
    ? path.join(home, "npm", "lib", "node_modules", "openclaw")
    : path.join(home, "candidate");
  await fs.mkdir(state, { mode: 0o700 });
  const entry = path.join(native.root, "dist", "index.js");
  await writeFixture(entry, "// isolated package identity\n");
  await writeJson(path.join(native.root, "package.json"), {
    name: "openclaw",
    version: "2026.9.5",
    ...(cliBinDir ? { bin: { openclaw: "openclaw.mjs" } } : {}),
  });
  process.env = {
    NODE_ENV: "test",
    HOME: home,
    USERPROFILE: home,
    PATH: [cliBinDir, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(path.delimiter),
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  let initialCli = entry;
  if (cliBinDir) {
    await fs.mkdir(cliBinDir, { recursive: true, mode: 0o700 });
    const publicEntry = path.join(native.root, "openclaw.mjs");
    await writeFixture(publicEntry, '#!/usr/bin/env node\nimport "./dist/index.js";\n', 0o700);
    initialCli = path.join(cliBinDir, "openclaw");
    await fs.symlink(publicEntry, initialCli);
    expect(await fs.realpath(initialCli)).toBe(publicEntry);
  }
  process.argv = [process.execPath, initialCli];
  await writeJson(process.env.OPENCLAW_CONFIG_PATH!, native.config);
  await migrateDaemonRuntimePins(process.env);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  mockSystemAccountHome();
  const control = path.join(home, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
      return "mnt_id:\t1\n";
    }
    if (args[0] === "/proc/self/mountinfo") {
      return "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
    }
    return readFile(...args);
  });
  native.systemctl.mockImplementation(async (_env, args: string[]) =>
    nativeResult("", args[0] === "show" ? 1 : 0),
  );
  native.serviceRuntime.mockResolvedValue(runtime("stopped"));
  const existing = {
    programArguments: [
      process.execPath,
      "--max-old-space-size=4096",
      entry,
      "gateway",
      "--port",
      "19137",
    ],
    environment: { OPERATOR_SETTING: "retained", NODE_OPTIONS: "--max-old-space-size=4096" },
  };
  const plan = await buildPlan(existing);
  if (cliBinDir) {
    expect(plan.environment.PATH?.split(path.delimiter)).toContain(cliBinDir);
  }
  // The updater invokes the candidate's dist entry after the initial CLI install.
  process.argv = [process.execPath, entry];
  native.source =
    edit === "foreign-unit"
      ? path.join(home, "foreign-unit", "gateway.service")
      : resolveSystemdUnitPath(process.env);
  let original = buildSystemdUnit(plan).replace("KillMode=mixed\n", "");
  if (edit === "ExecStartPre") {
    original = original.replace("[Service]", "[Service]\nExecStartPre=/operator/private-hook");
  }
  if (edit === "foreign-root" || edit === "old-installation") {
    const foreign = path.join(home, edit);
    await writeFixture(path.join(foreign, "dist", "index.js"), "// foreign package\n");
    await writeJson(path.join(foreign, "package.json"), {
      name: edit === "old-installation" ? "openclaw" : "operator-package",
      version: "2026.9.5",
    });
    original = original.replace(entry, path.join(foreign, "dist", "index.js"));
  }
  await writeFixture(native.source, original, 0o600);
  if (edit === "foreign-unit") {
    const managedSource = resolveSystemdUnitPath(process.env);
    await writeFixture(managedSource, original, 0o600);
  }
  native.command.mockImplementation(async () => {
    const content = await fs.readFile(native.source, "utf8");
    return {
      programArguments: parseSystemdExecStart(/^ExecStart=(.*)$/mu.exec(content)?.[1] ?? ""),
      environment: parseSystemdInlineEnvironment(content),
      sourcePath: native.source,
      definitionPaths: [native.source],
    };
  });
  const run = createUpdateRun({ trigger: "cli" });
  process.env.OPENCLAW_UPDATE_RUN_ID = run.runId;
  return {
    original,
    source: native.source,
    runId: run.runId,
    servicePath: plan.environment.PATH,
    cliBinDir,
  };
}

function response() {
  const result = firstWrittenJsonArg<{
    ok: boolean;
    error?: string;
    warnings?: string[];
    definitionBackup?: GatewayServiceDefinitionBackupReceipt;
  }>(native.runtime.writeJson);
  if (!result) {
    throw new Error("Installer did not emit its JSON response.");
  }
  return result;
}

async function expectDefinitionBackups(f: { source: string; original: string }) {
  const directory = path.dirname(f.source);
  const backups = (await fs.readdir(directory)).filter((file) =>
    file.startsWith(`${path.basename(f.source)}.reconcile-`),
  );
  const originals = backups.filter(
    (file) => file.endsWith(".bak") && !file.endsWith(".receipt.bak"),
  );
  const receipts = backups.filter((file) => file.endsWith(".receipt.bak"));
  expect([originals.length, receipts.length]).toEqual([1, 1]);
  const backup = path.join(directory, originals[0]!);
  const checkpoint = path.join(directory, receipts[0]!);
  expect(await read(backup)).toBe(f.original);
  for (const file of [backup, checkpoint]) {
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(
    JSON.parse(await read(checkpoint)),
  );
  expect(backup).toBe(`${f.source}.reconcile-${receipt.id}.bak`);
  expect(checkpoint).toBe(`${f.source}.reconcile-${receipt.id}.receipt.bak`);
  expect(receipt.files[0]).toMatchObject({
    sourcePath: f.source,
    before: { sha256: createHash("sha256").update(f.original).digest("hex") },
  });
  return receipt;
}

async function rejectedInstall() {
  await expect(install()).rejects.toThrow("fixture-exit:1");
  return response();
}

async function expectPreserved(
  f: { source: string; original: string },
  before: string[],
  expected = f.original,
) {
  expect(await read(f.source)).toBe(expected);
  expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
  expect(systemctlCalls("restart")).toHaveLength(0);
}

function expectWarningStep(runId: string, detail: ReturnType<typeof expect.stringContaining>) {
  expect(getUpdateRun(runId)?.steps).toContainEqual(
    expect.objectContaining({
      step: expect.stringContaining("warning:managed-service-reconciliation"),
      detail,
    }),
  );
}

function expectPlistInteger(content: string, key: string, value: number) {
  expect(content).toMatch(new RegExp(`<key>${key}</key>\\s*<integer>${value}</integer>`));
}

async function runStandaloneDoctor(
  mode: "direct" | "maintenance" = "direct",
  running = true,
  config: OpenClawConfig = native.config,
  approveConfigRepair = false,
) {
  delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  delete process.env.OPENCLAW_UPDATE_RUN_ID;
  if (mode === "maintenance") {
    const execute = native.systemctl.getMockImplementation()!;
    native.systemctl.mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1][0] === "restart" && result.code === 0) {
        native.serviceRuntime.mockResolvedValue(runtime("running"));
      }
      return result;
    });
    const state = await readGatewayServiceState(resolveGatewayService(), { env: process.env });
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({ state, root: native.root });
    expect(verdict.kind).toBe("owned");
    await restoreDoctorGatewayService({
      before: {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: state.env,
        serviceUpdateVerdict: verdict,
      },
      serviceEnv: state.env,
      root: native.root,
      env: process.env,
      cfg: config,
      writeConfig: native.writeConfig,
      options: { repair: true, yes: true, nonInteractive: true },
      runtime: native.runtime,
      signal: new AbortController().signal,
      warnings: [],
      settle: (operation) => operation(),
    });
    return;
  }
  if (running) {
    native.serviceRuntime.mockResolvedValue(runtime("running"));
  }
  const prompter = createDoctorPrompter({
    runtime: native.runtime,
    options: { repair: true, yes: true, nonInteractive: true },
  });
  if (approveConfigRepair) {
    prompter.confirmRuntimeRepair = async () => true;
  }
  await maybeRepairGatewayServiceConfig(config, "local", native.runtime, prompter, {
    writeConfig: native.writeConfig,
  });
}

describe.skipIf(process.platform === "win32")("service definition repair", () => {
  it("Doctor maintenance retains pending recovery without another activation after an operator edit", async () => {
    const f = await fixture();
    const execute = native.systemctl.getMockImplementation()!;
    native.systemctl.mockImplementation(async (...args) => {
      if (args[1][0] === "restart") {
        await fs.appendFile(f.source, "# operator edit during failed activation\n");
        return nativeResult("", 1, "fixture activation failed");
      }
      return execute(...args);
    });
    await expect(runStandaloneDoctor("maintenance")).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome: "recovery-pending",
    });
    expect(await read(f.source)).toContain("# operator edit during failed activation");
    expect(systemctlCalls("restart")).toHaveLength(1);
  });

  it("repairs a published-driver user-prefix shim unit through the candidate installer", async () => {
    const f = await fixture(undefined, "user-prefix shim");
    await install();
    const result = response();
    expect(result.ok, result.error).toBe(true);
    expect(result.definitionBackup?.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourcePath: f.source })]),
    );
    const changed = await read(f.source);
    for (const value of [
      "KillMode=mixed",
      "--max-old-space-size=4096",
      "OPERATOR_SETTING=retained",
    ]) {
      expect(changed).toContain(value);
    }
    const repaired = await native.command();
    expect(repaired.environment?.PATH).toBe(f.servicePath);
    expect(await expectDefinitionBackups(f)).toEqual(result.definitionBackup);
    expect(repaired.environment?.PATH?.split(path.delimiter)).toContain(f.cliBinDir);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Reconciled Gateway service definition: Service.KillMode."),
    );
    expectWarningStep(f.runId, expect.stringContaining("Service.KillMode"));
  });

  it("restores the previous definition after candidate publication ENOSPC", async () => {
    const f = await fixture();
    const envFile = path.join(process.env.OPENCLAW_STATE_DIR!, "gateway.systemd.env");
    let injected = false;
    const originalPlan = installPlans.buildGatewayInstallPlan;
    vi.spyOn(installPlans, "buildGatewayInstallPlan").mockImplementation(async (...args) => {
      const plan = await originalPlan(...args);
      return {
        ...plan,
        environmentValueSources: { ...plan.environmentValueSources, OPERATOR_SETTING: "file" },
      };
    });
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const [file, contents, options] = args;
      if (
        typeof file === "string" &&
        file.startsWith(`${f.source}.`) &&
        file.endsWith(".tmp") &&
        typeof contents === "string" &&
        contents.includes("KillMode=mixed")
      ) {
        injected = true;
        expect(await read(envFile)).toContain("OPERATOR_SETTING=");
        await writeFile(file, contents.slice(0, 32), options);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return writeFile(...args);
    });
    const result = await rejectedInstall();
    expect(result.ok).toBe(false);
    expect(result.definitionBackup).toBeUndefined();
    expect(await read(f.source)).toBe(f.original);
    const detail = expect.stringMatching(
      /previous definition was (?:restored|left unchanged):.*ENOSPC/u,
    );
    expectWarningStep(f.runId, detail);
    expect(injected).toBe(true);
    expect(result.error).toContain("previous definition was restored");
    expect(result.error).toContain("SERVICE_DEFINITION_UNKNOWN:");
    expect(result.error).not.toContain("UPDATE_NATIVE_AUTHORITY");
    expect(result.warnings).toContainEqual(detail);
    const receipt = await expectDefinitionBackups(f);
    expect(receipt.files[0]?.after).toEqual(receipt.files[0]?.before);
    expect(receipt.files[1]).toMatchObject({ before: null, after: null });
    await expect(fs.stat(envFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(systemctlCalls("restart")).toHaveLength(0);
  });

  it.each([
    ["ExecStartPre", "Service.ExecStartPre"],
    ["foreign-unit", "selected service is outside the managed user-unit path"],
    ["foreign-root", "unknown or foreign installation"],
    ["old-installation", "unknown or foreign installation"],
  ] as const)(
    "preserves the entire definition when candidate repair finds %s",
    async (edit, warning) => {
      const f = await fixture(edit);
      if (edit === "old-installation") {
        native.serviceRuntime.mockResolvedValue({
          status: "unknown",
          detail: "fixture runtime unavailable",
        });
      }
      const before = await fs.readdir(path.dirname(f.source));
      const result = await rejectedInstall();
      expect(result.ok).toBe(false);
      expect(result.definitionBackup).toBeUndefined();
      expect(result.error).toContain("SERVICE_DEFINITION_UNKNOWN");
      expect(result.warnings).toContainEqual(expect.stringContaining(warning));
      await expectPreserved(f, before);
      expect(await read(resolveSystemdUnitPath(process.env))).toBe(f.original);
      if (edit === "old-installation") {
        expect(result.error).toContain("unknown or foreign installation");
        expect(systemctlCalls("daemon-reload")).toHaveLength(0);
      }
    },
  );

  it("preserves an edit made after audit reads the unit", async () => {
    const f = await fixture();
    const edited = f.original.replace("[Service]", "[Service]\nNice=7");
    const before = await fs.readdir(path.dirname(f.source));
    native.systemctl.mockImplementation(async (_env, args: string[]) => {
      if (
        args.includes("After,Wants,RestartUSec,KillMode,LoadState,TimeoutStopUSec,ControlGroup")
      ) {
        await fs.writeFile(f.source, edited);
      }
      return nativeResult("", args[0] === "show" ? 1 : 0);
    });
    await rejectedInstall();
    expect(response().warnings).toContainEqual(
      expect.stringContaining("Service definition changed"),
    );
    await expectPreserved(f, before, edited);
  });

  it.each([
    { seconds: 20, throttle: 10, migrated: true },
    { seconds: 20, throttle: 45, migrated: false },
    { seconds: 20, throttle: 45, migrated: true, portDrift: true },
    { seconds: 20, throttle: 45, migrated: true, updater: true },
    { seconds: 600, throttle: 10, migrated: false },
    { seconds: 30, throttle: 10, migrated: false },
    { seconds: 600, throttle: 1, migrated: true },
    { seconds: 600, throttle: 10, migrated: true, portDrift: true },
    { seconds: 30, throttle: 10, migrated: true, portDrift: true },
    { seconds: 20, throttle: 10, migrated: true, updater: true },
  ])(
    "migrates only the retired LaunchAgent timeout ($seconds, throttle=$throttle, portDrift=$portDrift, updater=$updater)",
    async ({ seconds, throttle, migrated, portDrift, updater }) => {
      await fixture();
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
        if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
          throw new Error(`Unexpected fixture subprocess: ${file}`);
        }
        return decodeLaunchAgentPlistFixture(options.input, args[1]);
      });
      native.launchctl.mockImplementation(async (args) =>
        nativeResult(
          args[0] === "print" ? `${args[1]} = {\n\tstate = running\n\tpid = 4242\n}\n` : "",
        ),
      );
      const plan = await buildPlan();
      const source = resolveLaunchAgentPlistPath(process.env);
      const { stdoutPath } = resolveGatewaySupervisorLogPaths(process.env);
      const original = buildLaunchAgentPlist({
        ...plan,
        label: "ai.openclaw.gateway",
        comment: "OpenClaw Gateway",
        stdoutPath,
        stderrPath: stdoutPath,
      })
        .replace(/(<key>ExitTimeOut<\/key>\s*<integer>)\d+/u, `$1${seconds}`)
        .replace(/(<key>ThrottleInterval<\/key>\s*<integer>)\d+/u, `$1${throttle}`);
      await writeFixture(source, original, 0o600);

      if (updater) {
        // Published drivers invoke the candidate installer with this existing marker.
        await install();
        expect(response().ok).toBe(true);
      } else {
        const config = portDrift
          ? { ...native.config, gateway: { ...native.config.gateway, port: 19138 } }
          : native.config;
        await runStandaloneDoctor("direct", true, config, portDrift);
      }

      expect(native.runtime.error).not.toHaveBeenCalled();
      const changed = await read(source);
      if (portDrift) {
        expect(changed).toContain("<string>19138</string>");
      }
      expectPlistInteger(changed, "ExitTimeOut", seconds === 20 && throttle !== 45 ? 330 : seconds);
      if (migrated) {
        expectPlistInteger(changed, "ThrottleInterval", throttle === 45 ? 45 : 10);
        await expectDefinitionBackups({ source, original });
        expect(
          native.launchctl.mock.calls.filter(([args]) => args[0] === "bootstrap"),
        ).toHaveLength(1);
      } else {
        expect(changed).toBe(original);
        expect(
          native.launchctl.mock.calls.some(([args]) => ["bootout", "bootstrap"].includes(args[0]!)),
        ).toBe(false);
      }
      const diagnostics = updater
        ? response().warnings?.join("\n")
        : native.note.mock.calls.map(([message]) => message).join("\n");
      expect(diagnostics).toContain(
        throttle === 45
          ? "not changed because the definition is customized"
          : updater
            ? "Reconciled Gateway service definition: ExitTimeOut."
            : seconds === 20
              ? "ExitTimeOut=330"
              : "Custom ExitTimeOut; not changed.",
      );
    },
  );

  it.each(["stopped service", "unapproved token"] as const)(
    "standalone Doctor preserves native policy for a %s",
    async (reason) => {
      const f = await fixture();
      const before = await fs.readdir(path.dirname(f.source));
      let config: OpenClawConfig = native.config;
      if (reason === "unapproved token") {
        config = { gateway: { mode: "local", port: 19137, auth: { mode: "token" } } };
        await writeJson(process.env.OPENCLAW_CONFIG_PATH!, config);
        process.env.OPENCLAW_GATEWAY_TOKEN = "doctor-policy-environment-fixture-token";
      }
      await runStandaloneDoctor("direct", reason === "unapproved token", config);
      expect(native.writeConfig).not.toHaveBeenCalled();
      await expectPreserved(f, before);
    },
  );
});
