import fs from "node:fs/promises";
import path from "node:path";
import { err, ok } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ServiceConfigAudit } from "../daemon/service-audit.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  makeDoctorIo,
  makeDoctorPrompts,
  pinSnapshotMock,
  registerDoctorRuntimePinTests,
} from "./doctor-gateway-runtime.test-utils.js";
import { registerDoctorServiceDefaultsTests } from "./doctor-gateway-service-defaults.test-support.js";
import {
  maybeRepairGatewayServiceConfig,
  maybeResolveDuelingSystemdGatewayScopes,
} from "./doctor-gateway-services.js";
import {
  fsMocks,
  mocks,
  mockProcessPlatform,
  expectNoteContaining,
  expectNoNoteContaining,
} from "./doctor-gateway-services.native.test-support.js";
import { registerDoctorGatewayTokenRepairTests } from "./doctor-gateway-services.tokens.test-support.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { formatServiceRepairDeferredNote } from "./doctor-service-repair-policy.js";

await vi.hoisted(() => import("./doctor-gateway-services.native.test-support.js"));

const originalStdinIsTTY = process.stdin.isTTY;
const originalPlatform = process.platform;
const savedEnv = captureEnv([
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_UPDATE_IN_PROGRESS",
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART",
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR",
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION",
]);

async function runRepair(
  cfg: OpenClawConfig = { gateway: {} },
  options: { allowExecSecretRefs?: boolean } = {},
  prompter = makeDoctorPrompts(),
) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), prompter, {
    ...options,
    writeConfig: mocks.writeConfig,
  });
}

const gatewayProgramArguments = createGatewayCommand().programArguments;

function createRecommendedServiceAudit(
  code: string,
  message: string,
  fields: Partial<ServiceConfigAudit["issues"][number]> = {},
): ServiceConfigAudit {
  return { ok: false, issues: [{ code, message, level: "recommended", ...fields }] };
}

function createGatewayInstallPlanFixture(): Awaited<
  ReturnType<typeof import("./daemon-install-helpers.js").buildGatewayInstallPlan>
> {
  return {
    runtime: "node",
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {},
  };
}

function createGatewayCommand(entrypoint = "/usr/local/bin/openclaw", runtime = "/usr/bin/node") {
  return {
    programArguments: [runtime, entrypoint, "gateway", "--port", "18789"],
    environment: {},
  };
}

function expectNoServiceWrite(...operations: ("writeConfig" | "stage" | "install")[]) {
  for (const operation of operations) {
    expect(mocks[operation]).not.toHaveBeenCalled();
  }
}

function configNote(message: string) {
  expectNoteContaining(message, "Gateway service config");
}

async function withSourceCheckout(run: (entrypoint: string) => Promise<void>) {
  await withTempDir("openclaw-doctor-service-layout-", async (root) => {
    for (const directory of [".git", "src", "extensions", "dist"]) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
    }
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
      "utf8",
    );
    const entrypoint = path.join(root, "dist", "index.js");
    await fs.writeFile(entrypoint, "export {};\n", "utf8");
    await run(entrypoint);
  });
}

function setupGatewayEntrypointRepairScenario(current: string, installed: string) {
  mocks.readCommand.mockResolvedValue(createGatewayCommand(current));
  mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
  mocks.buildGatewayInstallPlan.mockResolvedValue({
    ...createGatewayCommand(installed),
    workingDirectory: "/tmp",
  });
  fsMocks.realpath.mockImplementation(async (value: string) => value);
}

function setupGatewayTokenRepairScenario() {
  mocks.readCommand.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    environment: { OPENCLAW_GATEWAY_TOKEN: "stale-token" },
  });
  mocks.auditGatewayServiceConfig.mockResolvedValue(
    createRecommendedServiceAudit(
      "gateway-token-mismatch",
      "Gateway service OPENCLAW_GATEWAY_TOKEN does not match gateway.auth.token",
    ),
  );
  mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
  mocks.install.mockResolvedValue(undefined);
}

describe("maybeRepairGatewayServiceConfig", () => {
  beforeEach(() => {
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    vi.clearAllMocks();
    mocks.writeConfig.mockReset().mockImplementation(async (nextConfig) => nextConfig);
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    fsMocks.realpath.mockImplementation(async (value: string) => value);
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.isDefaultInstallIdentity.mockReturnValue(true);
    mocks.readRuntime.mockResolvedValue({ status: "unknown" });
    mocks.needsNodeRuntimeMigration.mockReturnValue(false);
    mocks.renderSystemNodeWarning.mockReturnValue(undefined);
    mocks.resolveSystemNodeInfo.mockResolvedValue(null);
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status: "supported" });
    mocks.isSystemdUnitActive.mockResolvedValue(ok(false));
    mocks.resolveGatewayAuthTokenForService.mockImplementation(async (cfg: OpenClawConfig, env) => {
      const configToken =
        typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;
      const envToken = env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
      return { token: configToken || envToken };
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    mockProcessPlatform(originalPlatform);
    savedEnv.restore();
  });

  it("reports a passing vendor runtime note without rewriting the service", async () => {
    const command = createGatewayCommand("/opt/openclaw/dist/index.js");
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
      runtimeNote: "Node 24.15.0: unsupported version, capability check passed.",
    });
    await runRepair();
    expectNoteContaining("unsupported version, capability check passed", "Gateway runtime");
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("skips service audit and rewrite for a non-default install identity", async () => {
    mocks.isDefaultInstallIdentity.mockReturnValue(false);
    await runRepair();
    expect(mocks.readCommand).not.toHaveBeenCalled();
    expect(mocks.auditGatewayServiceConfig).not.toHaveBeenCalled();
    expectNoServiceWrite("stage", "install");
    expectNoteContaining(
      "service management skipped: non-default state dir or config path",
      "Gateway",
    );
  });

  it("reports an orphaned unsafe systemd backup without an active service command", async () => {
    mocks.readCommand.mockResolvedValue(null);
    mocks.auditGatewayServiceConfig.mockResolvedValue(
      createRecommendedServiceAudit(
        "systemd-unit-backup-unsafe",
        "Systemd service backup exposes gateway credentials.",
        { detail: "/home/test/.config/systemd/user/openclaw-gateway.service.bak" },
      ),
    );
    await runRepair();
    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ command: null, platform: process.platform }),
    );
    configNote("Systemd service backup exposes gateway credentials");
    expectNoServiceWrite("stage", "install");
  });

  it("passes exec SecretRef policy into service token resolution", async () => {
    setupGatewayTokenRepairScenario();
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "exec",
            provider: "execmain",
            id: "gateway/token",
          },
        },
      },
    };
    await runRepair(cfg, { allowExecSecretRefs: true });
    expect(mocks.resolveGatewayAuthTokenForService).toHaveBeenCalledWith(cfg, process.env, {
      allowExecSecretRefs: true,
    });
  });

  it("does not duplicate gateway runtime warnings already emitted by the node install plan", async () => {
    const nvmNode = "/home/test/.nvm/versions/node/v24.16.0/bin/node";
    mocks.readCommand.mockResolvedValue(createGatewayCommand(undefined, nvmNode));
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ warn }) => {
      warn?.(
        "System Node 20.20.2 at /usr/bin/node is outside the supported range. Using /home/test/.nvm/versions/node/v24.16.0/bin/node for the daemon.",
        "Gateway runtime",
      );
      return {
        programArguments: [nvmNode, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
        workingDirectory: "/tmp",
        environment: {},
      };
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [{ code: "runtime", message: "runtime migration", level: "recommended" }],
    });
    mocks.needsNodeRuntimeMigration.mockReturnValue(true);
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: "/usr/bin/node",
      version: "20.20.2",
      status: "unsupported",
    });
    mocks.renderSystemNodeWarning.mockReturnValue("duplicate doctor runtime warning");
    await runRepair();
    const runtimeNotes = mocks.note.mock.calls.filter(([, title]) => title === "Gateway runtime");
    const runtimeMessages = runtimeNotes.map(([message]) => message);
    expect(runtimeMessages).not.toContain("duplicate doctor runtime warning");
    expect(runtimeMessages.map((message) => String(message)).join("\n")).not.toContain("not found");
    expect(runtimeMessages.map((message) => String(message)).join("\n")).toContain(
      "Using /home/test/.nvm/versions/node/v24.16.0/bin/node",
    );
  });

  it("reports failed Bun probes without runtime migration", async () => {
    const command = createGatewayCommand(undefined, "/opt/bun");
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-runtime-probe-failed",
          message: "Gateway service Bun runtime check failed.",
          detail: "/opt/bun (cwd /root): EACCES",
        },
      ],
    });
    const prompter = makeDoctorPrompts();
    await runRepair(undefined, {}, prompter);
    configNote("/opt/bun (cwd /root): EACCES");
    expectNoNoteContaining("unsupported", "Gateway service config");
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledTimes(0);
    expect(mocks.install).toHaveBeenCalledTimes(0);
    for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ runtime: "bun", runtimePath: "/opt/bun" }));
    }
  });

  registerDoctorRuntimePinTests({ mocks, runRepair, createRecommendedServiceAudit });

  it("migrates an unsupported Bun Gateway service to supported system Node", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    const systemNodePath = "/usr/bin/node";
    mocks.readCommand.mockResolvedValue(createGatewayCommand(undefined, bunPath));
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
      programArguments: [runtimePath, ...gatewayProgramArguments.slice(1)],
      environment: {},
    }));
    mocks.auditGatewayServiceConfig.mockResolvedValue(
      createRecommendedServiceAudit("gateway-runtime-bun", "Bun runtime is unsupported"),
    );
    mocks.needsNodeRuntimeMigration.mockReturnValue(true);
    mocks.resolveSystemNodeInfo.mockResolvedValue({
      path: systemNodePath,
      version: "24.16.0",
      status: "supported",
    });
    await runRepair();
    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "node", runtimePath: systemNodePath }),
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: [systemNodePath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      }),
    );
  });

  registerDoctorServiceDefaultsTests({
    mocks,
    gatewayProgramArguments,
    runRepair,
    mockProcessPlatform,
    expectNoNoteContaining,
  });

  registerDoctorGatewayTokenRepairTests({ runRepair, setupGatewayTokenRepairScenario });

  it.each([
    [
      "an operator-owned managed key with a different embedded managed key",
      "/usr/local/bin/openclaw",
      { environment: { keys: ["MANAGED_A"] } },
      "gateway-managed-env-embedded",
    ],
    [
      "a file reset with an inline PATH issue",
      "/usr/local/bin/openclaw",
      { environment: { resetFiles: true } },
      "gateway-path-missing",
    ],
  ] as const)(
    "does not attribute unrelated repair issues to %s",
    async (_, entrypoint, overrides, issue) => {
      mockProcessPlatform("linux");
      const embeddedManagedIssue = issue === "gateway-managed-env-embedded";
      const managedDefinition = {
        ...createGatewayCommand(entrypoint),
        environment: embeddedManagedIssue
          ? { MANAGED_B: "embedded-base-value" }
          : { PATH: "/managed/bin" },
      };
      mocks.readCommand.mockResolvedValue({
        ...managedDefinition,
        workingDirectory: undefined,
        environment:
          "environment" in overrides && "keys" in overrides.environment
            ? {
                ...managedDefinition.environment,
                [overrides.environment.keys[0]]: "operator-owned",
              }
            : managedDefinition.environment,
        managedDefinition,
        managedOverrides: overrides,
      });
      mocks.auditGatewayServiceConfig.mockResolvedValue(
        createRecommendedServiceAudit(issue, "repair", {
          environmentKeys: embeddedManagedIssue ? ["MANAGED_B"] : undefined,
        }),
      );
      mocks.buildGatewayInstallPlan.mockResolvedValue({
        ...createGatewayCommand(entrypoint),
        ...(embeddedManagedIssue
          ? { environment: { OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "MANAGED_A,MANAGED_B" } }
          : {}),
        environmentValueSources: {
          PATH: "inline",
          OPENCLAW_GATEWAY_TOKEN: "inline",
        },
      });
      await runRepair({ gateway: { auth: { token: "configured-token" } } });
      expectNoNoteContaining("operator-owned systemd drop-in", "Gateway service config");
      expect(mocks.install).toHaveBeenCalledTimes(1);
    },
  );

  it("skips entrypoint rewrites for an active systemd unit", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      ...createGatewayCommand("/opt/old-openclaw/dist/index.js"),
      sourcePath: "/etc/systemd/system/custom-gateway.service",
      managedDefinition: createGatewayCommand("/opt/new-openclaw/dist/index.js"),
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(ok(true));
    await runRepair();
    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "system",
    );
    configNote("skipped command/entrypoint rewrites");
    expectNoServiceWrite("install", "stage");
  });

  it.each([
    ["command", { launcher: "command" as const }, "gateway-port-mismatch"],
    ["directory", { launcher: "working-directory" as const }, "gateway-entrypoint-mismatch"],
    ["environment", { environment: { keys: ["tavily_api_key"] } }, "gateway-managed-env-embedded"],
    ["lowercase proxy", { environment: { keys: ["https_proxy"] } }, "gateway-proxy-env-embedded"],
    ["file-backed token reset", { environment: { resetFiles: true } }, "gateway-token-mismatch"],
    ["future inline PATH reset", { environment: { resetInline: true } }, "gateway-path-missing"],
  ])(
    "does not rewrite a stopped service controlled by a %s drop-in",
    async (_, overrides, issue) => {
      mockProcessPlatform("linux");
      const fileReset = "environment" in overrides && "resetFiles" in overrides.environment;
      const managedDefinition = {
        ...createGatewayCommand("/usr/local/bin/openclaw"),
        environment: { TAVILY_API_KEY: "same-value", https_proxy: "http://proxy.local" },
      };
      mocks.readCommand.mockResolvedValue({
        ...managedDefinition,
        sourcePath: "/home/test/.config/systemd/user/custom-gateway.service",
        managedDefinition,
        managedOverrides: overrides,
      });
      mocks.auditGatewayServiceConfig.mockResolvedValue(
        createRecommendedServiceAudit(issue, "repair", {
          environmentKeys:
            issue === "gateway-proxy-env-embedded" ? ["https_proxy"] : ["TAVILY_API_KEY"],
        }),
      );
      mocks.buildGatewayInstallPlan.mockResolvedValue({
        ...managedDefinition,
        environment: {
          PATH: "/usr/bin",
          OPENCLAW_GATEWAY_TOKEN: "future-managed-token",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
        },
        environmentValueSources: {
          PATH: "inline",
          OPENCLAW_GATEWAY_TOKEN: fileReset ? "file" : "inline",
          tavily_api_key: fileReset ? "file" : "inline",
        },
      });
      await runRepair();
      configNote("operator-owned systemd drop-in");
      configNote("systemctl --user cat custom-gateway.service");
      expectNoServiceWrite("writeConfig", "install", "stage");
    },
  );

  it("leaves service metadata unchanged when the activity query fails alongside command drift", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      programArguments: ["/usr/bin/openclaw", "run"],
      environment: {},
      sourcePath: "/home/test/.config/systemd/user/openclaw-gateway.service",
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-command-missing",
          message: "Service command does not include the gateway subcommand",
          level: "aggressive",
        },
        {
          code: "gateway-port-mismatch",
          message: "Gateway service port does not match current gateway config.",
          detail: "18789 -> 18888",
          level: "recommended",
        },
      ],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
    mocks.isSystemdUnitActive.mockResolvedValue(err("Failed to connect to bus: Permission denied"));
    await runRepair({ gateway: { port: 18888 } });
    configNote("Gateway service port does not match current gateway config.");
    configNote("supervisor metadata unchanged");
    configNote("Service command does not include");
    configNote("Failed to connect to bus: Permission denied");
    configNote("systemctl --user status openclaw-gateway.service");
    expectNoNoteContaining("is running;", "Gateway service config");
    expectNoServiceWrite("writeConfig", "install", "stage");
  });

  it("skips entrypoint rewrite in non-interactive fix mode", async () => {
    setupGatewayEntrypointRepairScenario(
      "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
    );

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    await maybeRepairGatewayServiceConfig(
      { gateway: {} },
      "local",
      makeDoctorIo(),
      createDoctorPrompter({
        runtime: makeDoctorIo(),
        options: { repair: true, nonInteractive: true },
      }),
      { writeConfig: mocks.writeConfig },
    );
    configNote("Gateway service entrypoint does not match the current install.");
    configNote("openclaw gateway install --force");
    expectNoServiceWrite("stage", "install");
  });

  it("does not persist EnvironmentFile-backed service tokens into config", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-file-token" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: false, issues: [] });
    mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
    mocks.install.mockResolvedValue(undefined);
    const cfg: OpenClawConfig = { gateway: {} };
    await runRepair(cfg);
    expectNoServiceWrite("writeConfig", "stage");
    expect(mocks.buildGatewayInstallPlan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ config: cfg }),
    );
  });

  it("reports service config drift but skips repair when externally managed", async () => {
    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      setupGatewayEntrypointRepairScenario(
        "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
        "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      );
      const prompter = makeDoctorPrompts();
      await runRepair(undefined, {}, prompter);
      expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledOnce();
      configNote("Gateway service entrypoint does not match the current install.");
      expect(mocks.note).toHaveBeenCalledWith(
        formatServiceRepairDeferredNote("external"),
        "Gateway service config",
      );
      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(mocks.writeConfig).not.toHaveBeenCalled();
      expectNoServiceWrite("stage", "install");
    });
  });

  it("warns when the gateway service entrypoint resolves to a source checkout", async () => {
    await withSourceCheckout(async (entrypoint) => {
      mocks.readCommand.mockResolvedValue(createGatewayCommand(entrypoint));
      mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
      mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayCommand(entrypoint));
      await runRepair();
      configNote("resolves to a source checkout");
      configNote(
        "Run `openclaw gateway install --force` from the intended package install to replace the gateway service definition.",
      );
      expectNoNoteContaining("openclaw doctor --fix", "Gateway service config");
      expect(mocks.install).not.toHaveBeenCalled();
    });
  });

  it("does not duplicate Gateway service config panels for a source-checkout entrypoint with audit findings", async () => {
    await withSourceCheckout(async (currentEntrypoint) => {
      setupGatewayEntrypointRepairScenario(
        currentEntrypoint,
        "/usr/local/lib/node_modules/openclaw/dist/index.js",
      );
      await runRepair();
      const notes = mocks.note.mock.calls.filter(([, title]) => title === "Gateway service config");
      expect(notes).toHaveLength(1);
      const consolidated = notes[0]?.[0] ?? "";
      expect(consolidated).toContain(
        "Gateway service entrypoint does not match the current install.",
      );
      expect(consolidated).not.toContain("resolves to a source checkout");
      expect(consolidated.match(/openclaw gateway install --force/g) ?? []).toHaveLength(0);
    });
  });
});

describe("maybeResolveDuelingSystemdGatewayScopes", () => {
  const duelingInstallation = {
    kind: "dueling" as const,
    user: {
      scope: "user" as const,
      unitName: "openclaw-gateway.service",
      unitPath: "/home/test/.config/systemd/user/openclaw-gateway.service",
    },
    system: {
      scope: "system" as const,
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    },
  };

  beforeEach(() => {
    pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
    vi.clearAllMocks();
    mocks.writeConfig.mockReset().mockImplementation(async (nextConfig) => nextConfig);
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  afterEach(() => {
    mockProcessPlatform(originalPlatform);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  it.each([
    [true, "Cleanup of openclaw-gateway.service completed."],
    [false, "systemctl --user disable --now openclaw-gateway.service"],
  ] as const)("reports user-unit removal with disabled=%s", async (disabled, message) => {
    mocks.uninstallUserSystemdGatewayUnit.mockResolvedValue({
      unitName: "openclaw-gateway.service",
      unitPath: duelingInstallation.user.unitPath,
      removed: true,
      disabled,
    });
    const runtime = makeDoctorIo();
    await maybeResolveDuelingSystemdGatewayScopes(runtime, makeDoctorPrompts());
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(message));
    if (disabled) {
      expect(mocks.uninstallUserSystemdGatewayUnit).toHaveBeenCalledTimes(1);
    } else {
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("sole gateway manager"));
    }
  });

  it("emits cleanup hints and does not remove anything when declined", async () => {
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([
      "systemctl --user disable --now openclaw-gateway.service",
      "rm ~/.config/systemd/user/openclaw-gateway.service",
    ]);
    const prompter = makeDoctorPrompts();
    prompter.confirmRuntimeRepair = vi.fn().mockResolvedValue(false);
    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
    expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalled();
  });

  it("skips removal and repair confirmation when externally supervised", async () => {
    const prompter = makeDoctorPrompts();
    await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, async () => {
      await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);
    });
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      formatServiceRepairDeferredNote("external"),
      "Gateway cleanup skipped",
    );
  });

  it("fails closed when the system unit ownership probe errors", async () => {
    mocks.isSystemUnitActiveAndEnabled.mockRejectedValue(new Error("systemctl wedged"));
    const prompter = makeDoctorPrompts();
    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });

  it("does nothing for a single-scope (user-only) install", async () => {
    mocks.findSystemdGatewayInstallation.mockResolvedValue({
      kind: "user",
      user: duelingInstallation.user,
    });
    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), makeDoctorPrompts());
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });

  it("does nothing on non-Linux platforms", async () => {
    mockProcessPlatform("darwin");
    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), makeDoctorPrompts());
    expect(mocks.findSystemdGatewayInstallation).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });
});
