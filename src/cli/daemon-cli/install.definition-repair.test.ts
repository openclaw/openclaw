import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as installPlans from "../../commands/daemon-install-helpers.js";
import { maybeRepairGatewayServiceConfig } from "../../commands/doctor-gateway-services.js";
import { restoreDoctorGatewayService } from "../../commands/doctor-maintenance-restoration.js";
import { createDoctorPrompter } from "../../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../../config/config.js";
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
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
} from "../../daemon/systemd-unit.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { firstWrittenJsonArg } from "../test-runtime-capture.js";
import { inspectManagedGatewayServiceBeforeUpdate } from "../update-cli/update-command-service-plan.js";
import { runDaemonInstall } from "./install.js";

const native = vi.hoisted(() => ({
  root: "",
  source: "",
  command: vi.fn<() => Promise<GatewayServiceCommandConfig>>(),
  systemctl: vi.fn<typeof import("../../daemon/systemd-exec.js").execSystemctlUser>(),
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
    version: "26.8.1",
    sqliteVersion: "3.53.4",
  }),
  emitNodeRuntimeWarning: async () => {},
}));
vi.mock("../../daemon/systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: native.command,
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
let originalEnv: NodeJS.ProcessEnv;
let originalArgv: string[];
beforeEach(() => {
  originalEnv = process.env;
  originalArgv = process.argv;
  vi.clearAllMocks();
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  process.env = originalEnv;
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function fixture(
  edit?:
    | "Nice"
    | "ExecStartPre"
    | "foreign-unit"
    | "foreign-root"
    | "old-installation"
    | "native-policy",
  layout: "direct" | "user-prefix shim" = "direct",
) {
  const home = await fs.realpath(dirs.make("candidate-service-repair-"));
  const state = path.join(home, ".openclaw");
  const cliBinDir = layout === "user-prefix shim" ? path.join(home, "npm", "bin") : undefined;
  native.root = cliBinDir
    ? path.join(home, "npm", "lib", "node_modules", "openclaw")
    : path.join(home, "candidate");
  await fs.mkdir(path.join(native.root, "dist"), { recursive: true, mode: 0o700 });
  await fs.mkdir(state, { mode: 0o700 });
  const entry = path.join(native.root, "dist", "index.js");
  await fs.writeFile(entry, "// isolated package identity\n");
  await fs.writeFile(
    path.join(native.root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.5",
      ...(cliBinDir ? { bin: { openclaw: "openclaw.mjs" } } : {}),
    }),
  );
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
    await fs.writeFile(publicEntry, '#!/usr/bin/env node\nimport "./dist/index.js";\n', {
      mode: 0o700,
    });
    initialCli = path.join(cliBinDir, "openclaw");
    await fs.symlink(publicEntry, initialCli);
    expect(await fs.realpath(initialCli)).toBe(publicEntry);
    expect(await fs.realpath(initialCli)).not.toBe(await fs.realpath(entry));
  }
  process.argv = [process.execPath, initialCli];
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(native.config));
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
  native.systemctl.mockImplementation(async (_env, args: string[]) => ({
    code: args[0] === "show" ? 1 : 0,
    stdout: "",
    stderr: "",
    termination: "exit",
  }));
  native.serviceRuntime.mockResolvedValue({
    status: "stopped",
    systemd: { scope: "user", managerUid: process.getuid?.() ?? 501 },
  });
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
  const plan = await installPlans.buildGatewayInstallPlan({
    env: process.env,
    port: 19137,
    runtime: "node",
    runtimePath: process.execPath,
    existingCommand: existing,
    existingEnvironment: existing.environment,
    config: { gateway: { mode: "local", port: 19137 } },
  });
  if (cliBinDir) {
    expect(plan.environment.PATH?.split(path.delimiter)).toContain(cliBinDir);
  }
  // The updater invokes the candidate's dist entry after the initial CLI install.
  process.argv = [process.execPath, entry];
  native.source =
    edit === "foreign-unit"
      ? path.join(home, "foreign-unit", "gateway.service")
      : resolveSystemdUnitPath(process.env);
  await fs.mkdir(path.dirname(native.source), { recursive: true, mode: 0o700 });
  if (edit === "native-policy") {
    plan.environment.OPENCLAW_SERVICE_VERSION = "2026.7.1-2";
  }
  let original = buildSystemdUnit(plan).replace("KillMode=mixed\n", "");
  if (edit === "native-policy") {
    original = original
      .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
      .replace("TimeoutStopSec=330", "TimeoutStopSec=600")
      .replace("StartLimitIntervalSec=300", "StartLimitIntervalSec=60");
  }
  if (edit === "Nice" || edit === "ExecStartPre") {
    original = original.replace(
      "[Service]",
      `[Service]\n${edit}=${edit === "Nice" ? "7" : "/operator/private-hook"}`,
    );
  }
  if (edit === "foreign-root" || edit === "old-installation") {
    const foreign = path.join(home, edit);
    await fs.mkdir(path.join(foreign, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(foreign, "package.json"),
      JSON.stringify({
        name: edit === "old-installation" ? "openclaw" : "operator-package",
        version: "2026.9.5",
      }),
    );
    await fs.writeFile(path.join(foreign, "dist", "index.js"), "// foreign package\n");
    original = original.replace(entry, path.join(foreign, "dist", "index.js"));
  }
  await fs.writeFile(native.source, original, { mode: 0o600 });
  if (edit === "foreign-unit") {
    const managedSource = resolveSystemdUnitPath(process.env);
    await fs.mkdir(path.dirname(managedSource), { recursive: true, mode: 0o700 });
    await fs.writeFile(managedSource, original, { mode: 0o600 });
  }
  native.command.mockImplementation(async () => {
    const content = await fs.readFile(native.source, "utf8");
    const environment = Object.fromEntries(
      content
        .split("\n")
        .filter((line) => line.startsWith("Environment="))
        .flatMap((line) =>
          parseSystemdEnvAssignments(line.slice(12)).map(({ key, value }) => [key, value]),
        ),
    );
    return {
      programArguments: parseSystemdExecStart(/^ExecStart=(.*)$/mu.exec(content)?.[1] ?? ""),
      environment,
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
  expect(originals).toHaveLength(1);
  expect(receipts).toHaveLength(1);
  const backup = path.join(directory, originals[0]!);
  const checkpoint = path.join(directory, receipts[0]!);
  expect(await fs.readFile(backup, "utf8")).toBe(f.original);
  for (const file of [backup, checkpoint]) {
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  const receipt = GatewayServiceDefinitionBackupReceiptSchema.parse(
    JSON.parse(await fs.readFile(checkpoint, "utf8")),
  );
  expect(backup).toBe(`${f.source}.reconcile-${receipt.id}.bak`);
  expect(checkpoint).toBe(`${f.source}.reconcile-${receipt.id}.receipt.bak`);
  expect(receipt.files[0]).toMatchObject({
    sourcePath: f.source,
    before: { sha256: createHash("sha256").update(f.original).digest("hex") },
  });
  return receipt;
}

async function runStandaloneDoctor(
  mode: "direct" | "maintenance" = "direct",
  running = true,
  config: OpenClawConfig = native.config,
) {
  delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  delete process.env.OPENCLAW_UPDATE_RUN_ID;
  if (mode === "maintenance") {
    const execute = native.systemctl.getMockImplementation()!;
    native.systemctl.mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1][0] === "restart" && result.code === 0) {
        native.serviceRuntime.mockResolvedValue({
          status: "running",
          pid: 4242,
          systemd: { scope: "user", managerUid: process.getuid?.() ?? 501 },
        });
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
    native.serviceRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
      systemd: { scope: "user", managerUid: process.getuid?.() ?? 501 },
    });
  }
  const prompter = createDoctorPrompter({
    runtime: native.runtime,
    options: { repair: true, yes: true, nonInteractive: true },
  });
  await maybeRepairGatewayServiceConfig(config, "local", native.runtime, prompter, {
    writeConfig: native.writeConfig,
  });
}

it.skipIf(process.platform === "win32").each(["direct", "maintenance"] as const)(
  "repairs native policy through standalone Doctor with the shared backup transaction (%s)",
  async (mode) => {
    const f = await fixture("native-policy");
    await runStandaloneDoctor(mode);
    expect(native.runtime.error).not.toHaveBeenCalled();
    const changed = await fs.readFile(f.source, "utf8");
    expect(changed).toMatch(/^KillMode=mixed$/mu);
    expect(changed).toMatch(/^TimeoutStartSec=45$/mu);
    expect(changed).toMatch(/^TimeoutStopSec=600$/mu);
    expect(changed).toContain("OPERATOR_SETTING=retained");
    await expectDefinitionBackups(f);
    expect(native.systemctl.mock.calls.filter(([, args]) => args[0] === "restart")).toHaveLength(1);
    expect(native.note.mock.calls.map(([message]) => message)).toContainEqual(
      expect.stringContaining("Reconciled Gateway service definition:"),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "standalone Doctor preserves an already-stopped service with stale native policy",
  async () => {
    const f = await fixture();
    const before = await fs.readdir(path.dirname(f.source));
    await runStandaloneDoctor("direct", false);
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
  },
);

it.skipIf(process.platform === "win32").each(["Nice", "ExecStartPre"] as const)(
  "standalone Doctor preserves native policy with an unknown %s edit",
  async (edit) => {
    const f = await fixture(edit);
    const before = await fs.readdir(path.dirname(f.source));
    await runStandaloneDoctor();
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "standalone Doctor does not persist an environment token as policy-only repair",
  async () => {
    const f = await fixture();
    const config: OpenClawConfig = {
      gateway: { mode: "local", port: 19137, auth: { mode: "token" } },
    };
    await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
    process.env.OPENCLAW_GATEWAY_TOKEN = "doctor-policy-environment-fixture-token";
    await runStandaloneDoctor("direct", true, config);
    expect(native.writeConfig).not.toHaveBeenCalled();
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "Doctor maintenance retains pending recovery without another activation after an operator edit",
  async () => {
    const f = await fixture();
    const execute = native.systemctl.getMockImplementation()!;
    native.systemctl.mockImplementation(async (...args) => {
      if (args[1][0] === "restart") {
        await fs.appendFile(f.source, "# operator edit during failed activation\n");
        return { code: 1, stdout: "", stderr: "fixture activation failed", termination: "exit" };
      }
      return execute(...args);
    });
    await expect(runStandaloneDoctor("maintenance")).rejects.toMatchObject({
      code: "service-authority-revoked",
      outcome: "recovery-pending",
    });
    expect(await fs.readFile(f.source, "utf8")).toContain(
      "# operator edit during failed activation",
    );
    expect(native.systemctl.mock.calls.filter(([, args]) => args[0] === "restart")).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32")(
  "standalone Doctor restores the backed-up native definition after activation fails",
  async () => {
    const f = await fixture();
    const execute = native.systemctl.getMockImplementation()!;
    let failed = false;
    native.systemctl.mockImplementation(async (...args) => {
      if (args[1][0] === "restart" && !failed) {
        failed = true;
        return { code: 1, stdout: "", stderr: "fixture activation failed", termination: "exit" };
      }
      return execute(...args);
    });
    await runStandaloneDoctor();
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    await expectDefinitionBackups(f);
    expect(native.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("previous definition was restored"),
    );
  },
);

it.skipIf(process.platform === "win32").each(["direct", "user-prefix shim"] as const)(
  "repairs a published-driver unit through the candidate installer with receipt and warning history (%s)",
  async (layout) => {
    const f = await fixture(undefined, layout);
    await runDaemonInstall({ force: true, json: true }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "fixture-exit:1") {
        throw error;
      }
    });
    const result = response();
    expect(result.ok, result.error).toBe(true);
    expect(result.definitionBackup?.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourcePath: f.source })]),
    );
    const changed = await fs.readFile(f.source, "utf8");
    expect(changed).toContain("KillMode=mixed");
    expect(changed).toContain("--max-old-space-size=4096");
    expect(changed).toContain("OPERATOR_SETTING=retained");
    const repaired = await native.command();
    expect(repaired.environment?.PATH).toBe(f.servicePath);
    if (f.cliBinDir) {
      expect(repaired.environment?.PATH?.split(path.delimiter)).toContain(f.cliBinDir);
    }
    expect(await expectDefinitionBackups(f)).toEqual(result.definitionBackup);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Reconciled Gateway service definition: Service.KillMode."),
    );
    expect(getUpdateRun(f.runId)?.steps).toContainEqual(
      expect.objectContaining({
        step: expect.stringContaining("warning:managed-service-reconciliation"),
        detail: expect.stringContaining("Service.KillMode"),
      }),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "refreshes an eligible same-version installation onto the candidate root through the updater installer",
  async () => {
    const f = await fixture("old-installation");
    const previous = await native.command();
    expect(previous.programArguments).not.toContain(path.join(native.root, "dist", "index.js"));
    await runDaemonInstall({ force: true, json: true });
    const result = response();
    expect(result.ok, result.error).toBe(true);
    expect((await native.command()).programArguments).toContain(
      path.join(native.root, "dist", "index.js"),
    );
    expect(await expectDefinitionBackups(f)).toEqual(result.definitionBackup);
    expect(native.serviceRuntime).toHaveBeenCalled();
    expect(native.systemctl.mock.calls.filter(([, args]) => args[0] === "restart")).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32")(
  "leaves an old installation unchanged when its native runtime cannot be inspected",
  async () => {
    const f = await fixture("old-installation");
    native.serviceRuntime.mockResolvedValue({
      status: "unknown",
      detail: "fixture runtime unavailable",
    });
    const before = await fs.readdir(path.dirname(f.source));
    await expect(runDaemonInstall({ force: true, json: true })).rejects.toThrow("fixture-exit:1");
    expect(response().error).toContain("unknown or foreign installation");
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
    expect(
      native.systemctl.mock.calls.some(
        ([, args]) => args[0] === "daemon-reload" || args[0] === "restart",
      ),
    ).toBe(false);
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "preserves the previous definition when unit publication runs out of space (new environment file=%s)",
  async (fileBacked) => {
    const f = await fixture();
    const envFile = path.join(process.env.OPENCLAW_STATE_DIR!, "gateway.systemd.env");
    if (fileBacked) {
      const buildPlan = installPlans.buildGatewayInstallPlan;
      vi.spyOn(installPlans, "buildGatewayInstallPlan").mockImplementation(async (...args) => {
        const plan = await buildPlan(...args);
        return {
          ...plan,
          environmentValueSources: { ...plan.environmentValueSources, OPERATOR_SETTING: "file" },
        };
      });
    }
    const writeFile = fs.writeFile.bind(fs);
    let injected = false;
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
        if (fileBacked) {
          expect(await fs.readFile(envFile, "utf8")).toContain("OPERATOR_SETTING=");
        }
        await writeFile(file, contents.slice(0, 32), options);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return writeFile(...args);
    });
    await expect(runDaemonInstall({ force: true, json: true })).rejects.toThrow("fixture-exit:1");
    expect(injected).toBe(true);
    const result = response();
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      fileBacked ? "previous definition was restored" : "previous definition was left unchanged",
    );
    expect(result.error).toContain("SERVICE_DEFINITION_UNKNOWN:");
    expect(result.error).not.toContain("UPDATE_NATIVE_AUTHORITY");
    expect(result.definitionBackup).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.stringMatching(/previous definition was (?:restored|left unchanged):.*ENOSPC/u),
    );
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    const receipt = await expectDefinitionBackups(f);
    expect(receipt.files[0]?.after).toEqual(receipt.files[0]?.before);
    if (fileBacked) {
      expect(receipt.files[1]).toMatchObject({ before: null, after: null });
      await expect(fs.stat(envFile)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
    expect(getUpdateRun(f.runId)?.steps).toContainEqual(
      expect.objectContaining({
        step: expect.stringContaining("warning:managed-service-reconciliation"),
        detail: expect.stringMatching(
          /previous definition was (?:restored|left unchanged):.*ENOSPC/u,
        ),
      }),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "restores and reloads the previous definition after candidate activation fails",
  async () => {
    const f = await fixture();
    const execute = native.systemctl.getMockImplementation()!;
    native.systemctl.mockImplementation(async (...args) =>
      args[1][0] === "restart"
        ? { code: 1, stdout: "", stderr: "fixture activation failed", termination: "exit" }
        : execute(...args),
    );
    await expect(runDaemonInstall({ force: true, json: true })).rejects.toThrow("fixture-exit:1");
    expect(response().error).toContain("previous definition was restored");
    expect(response().definitionBackup).toBeUndefined();
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(
      native.systemctl.mock.calls.filter(([, args]) => args[0] === "daemon-reload"),
    ).toHaveLength(2);
    expect(getUpdateRun(f.runId)?.steps).toContainEqual(
      expect.objectContaining({
        step: expect.stringContaining("warning:managed-service-reconciliation"),
        detail: expect.stringContaining("previous definition was restored"),
      }),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "preserves custom timeouts while recording a successful native-policy repair",
  async () => {
    const f = await fixture("native-policy");
    expect(f.original).toContain("StartLimitIntervalSec=60");
    await runDaemonInstall({ force: true, json: true });
    const result = response();
    expect(result.ok, result.error).toBe(true);
    expect(result.error).toBeUndefined();
    const changed = await fs.readFile(f.source, "utf8");
    expect(changed).toMatch(/^TimeoutStartSec=45$/mu);
    expect(changed).toMatch(/^TimeoutStopSec=600$/mu);
    expect(changed).toMatch(/^StartLimitIntervalSec=300$/mu);
    expect(changed).toMatch(/^KillMode=mixed$/mu);
    expect(await expectDefinitionBackups(f)).toEqual(result.definitionBackup);
    const steps = getUpdateRun(f.runId)?.steps;
    for (const key of ["Service.TimeoutStartSec", "Service.TimeoutStopSec"]) {
      const warning = result.warnings?.find(
        (message) => message.includes(key) && message.includes("not changed"),
      );
      expect(warning).toEqual(expect.any(String));
      expect(steps).toContainEqual(
        expect.objectContaining({
          step: expect.stringContaining("warning:managed-service-reconciliation"),
          detail: warning,
        }),
      );
    }
    expect(steps).toContainEqual(
      expect.objectContaining({
        step: expect.stringContaining("warning:managed-service-reconciliation"),
        detail: expect.stringMatching(
          /Reconciled Gateway service definition:.*Unit\.StartLimitIntervalSec/u,
        ),
      }),
    );
    expect(native.systemctl.mock.calls.filter(([, args]) => args[0] === "restart")).toHaveLength(1);
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["Nice", "ExecStartPre", "foreign-unit", "foreign-root"] as const)(
  "preserves the entire definition when candidate repair finds %s",
  async (edit) => {
    const f = await fixture(edit);
    const before = await fs.readdir(path.dirname(f.source));
    await expect(runDaemonInstall({ force: true, json: true })).rejects.toThrow("fixture-exit:1");
    const result = response();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SERVICE_DEFINITION_UNKNOWN");
    expect(result.definitionBackup).toBeUndefined();
    if (edit === "Nice" || edit === "ExecStartPre") {
      expect(result.warnings).toContainEqual(expect.stringContaining(`Service.${edit}`));
    } else {
      expect(result.warnings).toContainEqual(
        expect.stringContaining(
          edit === "foreign-unit"
            ? "selected service is outside the managed user-unit path"
            : "unknown or foreign installation",
        ),
      );
    }
    expect(await fs.readFile(f.source, "utf8")).toBe(f.original);
    expect(await fs.readFile(resolveSystemdUnitPath(process.env), "utf8")).toBe(f.original);
    expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves an edit made after audit reads the unit",
  async () => {
    const f = await fixture();
    const edited = f.original.replace("[Service]", "[Service]\nNice=7");
    const before = await fs.readdir(path.dirname(f.source));
    native.systemctl.mockImplementation(async (_env, args: string[]) => {
      if (args.includes("After,Wants,RestartUSec,KillMode,LoadState,TimeoutStopUSec")) {
        await fs.writeFile(f.source, edited);
      }
      return { code: args[0] === "show" ? 1 : 0, stdout: "", stderr: "", termination: "exit" };
    });
    await expect(runDaemonInstall({ force: true, json: true })).rejects.toThrow("fixture-exit:1");
    expect(response().warnings).toContainEqual(
      expect.stringContaining("Service definition changed"),
    );
    expect(await fs.readFile(f.source, "utf8")).toBe(edited);
    expect(await fs.readdir(path.dirname(f.source))).toEqual(before);
    expect(native.systemctl.mock.calls.some(([, args]) => args[0] === "restart")).toBe(false);
  },
);
