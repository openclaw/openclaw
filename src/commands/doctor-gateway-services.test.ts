import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
// Doctor gateway service tests cover service audit diagnostics and duplicate gateway service reporting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { ServiceConfigAudit } from "../daemon/service-audit.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  makeDoctorIo,
  makeDoctorPrompts,
  pinSnapshotMock,
  registerDoctorRuntimePinTests,
} from "./doctor-gateway-runtime.test-utils.js";
import { registerDoctorServiceDefaultsTests } from "./doctor-gateway-service-defaults.test-support.js";
import {
  callArg,
  expectCallConfigGatewayAuthToken,
  expectCallField,
  expectGatewayAuthToken,
  requireRecord,
} from "./doctor-gateway-services.assertions.test-support.js";
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
import { createDoctorPrompter } from "./doctor-prompter.js";
import { formatServiceRepairDeferredNote } from "./doctor-service-repair-policy.js";

await vi.hoisted(() => import("./doctor-gateway-services.native.test-support.js"));

const originalStdinIsTTY = process.stdin.isTTY;
const originalPlatform = process.platform;
const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
const originalParentSupportsConfigWrite =
  process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
const originalParentSupportsGatewayRestart =
  process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART;
const originalParentAllowsGatewayServiceRepair =
  process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR;
const originalParentAllowsGatewayActivation =
  process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION;

async function runRepair(cfg: OpenClawConfig, options: { allowExecSecretRefs?: boolean } = {}) {
  await maybeRepairGatewayServiceConfig(cfg, "local", makeDoctorIo(), makeDoctorPrompts(), {
    ...options,
    writeConfig: mocks.writeConfig,
  });
}

async function runNonInteractiveRepair(params: {
  cfg?: OpenClawConfig;
  updateInProgress?: boolean;
  force?: boolean;
}) {
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  if (params.updateInProgress) {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  } else {
    delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  }
  await maybeRepairGatewayServiceConfig(
    params.cfg ?? { gateway: {} },
    "local",
    makeDoctorIo(),
    createDoctorPrompter({
      runtime: makeDoctorIo(),
      options: {
        repair: true,
        nonInteractive: true,
        force: params.force,
      },
    }),
    { writeConfig: mocks.writeConfig },
  );
}

const gatewayProgramArguments = [
  "/usr/bin/node",
  "/usr/local/bin/openclaw",
  "gateway",
  "--port",
  "18789",
];

function createRecommendedServiceAudit(code: string, message: string): ServiceConfigAudit {
  return { ok: false, issues: [{ code, message, level: "recommended" }] };
}

function createGatewayInstallPlanFixture(): Awaited<
  ReturnType<typeof import("./daemon-install-helpers.js").buildGatewayInstallPlan>
> {
  return {
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {},
  };
}

function createGatewayCommand(entrypoint: string) {
  return {
    programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"],
    environment: {},
  };
}

function setupGatewayEntrypointRepairScenario(params: {
  currentEntrypoint: string;
  installEntrypoint: string;
  installWorkingDirectory?: string;
  realpath?: (value: string) => Promise<string>;
  realpathError?: Error;
}) {
  mocks.readCommand.mockResolvedValue(createGatewayCommand(params.currentEntrypoint));
  mocks.auditGatewayServiceConfig.mockResolvedValue({
    ok: true,
    issues: [],
  });
  mocks.buildGatewayInstallPlan.mockResolvedValue({
    ...createGatewayCommand(params.installEntrypoint),
    ...(params.installWorkingDirectory ? { workingDirectory: params.installWorkingDirectory } : {}),
  });
  if (params.realpath) {
    fsMocks.realpath.mockImplementation(params.realpath);
  } else if (params.realpathError) {
    fsMocks.realpath.mockRejectedValue(params.realpathError);
  } else {
    fsMocks.realpath.mockImplementation(async (value: string) => value);
  }
}

function setupGatewayTokenRepairScenario() {
  mocks.readCommand.mockResolvedValue({
    programArguments: gatewayProgramArguments,
    environment: {
      OPENCLAW_GATEWAY_TOKEN: "stale-token",
    },
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
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
    if (originalParentSupportsConfigWrite === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE =
        originalParentSupportsConfigWrite;
    }
    if (originalParentSupportsGatewayRestart === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART =
        originalParentSupportsGatewayRestart;
    }
    if (originalParentAllowsGatewayServiceRepair === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR =
        originalParentAllowsGatewayServiceRepair;
    }
    if (originalParentAllowsGatewayActivation === undefined) {
      delete process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION;
    } else {
      process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION =
        originalParentAllowsGatewayActivation;
    }
  });

  it.each(["NODE_OPTIONS", "argv"])(
    "reports configured Gateway heap controls from %s separately from runtime measurements",
    async (source) => {
      const command = createGatewayCommand("/opt/openclaw/dist/index.js");
      if (source === "NODE_OPTIONS") {
        command.environment = { NODE_OPTIONS: "--max-old-space-size=6144" };
      } else {
        command.programArguments.splice(1, 0, "--max-old-space-size=6144");
      }
      mocks.readCommand.mockResolvedValue(command);
      mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
      mocks.buildGatewayInstallPlan.mockResolvedValue(command);

      await runRepair({ gateway: {} });

      expectNoteContaining(`service ${source}: --max-old-space-size=6144`, "Gateway heap");
      expectNoteContaining("installer recommendation:", "Gateway heap");
      expectNoteContaining("runtime V8 ceiling: not measured", "Gateway heap");
    },
  );

  it("reports a passing vendor runtime note without rewriting the service", async () => {
    const command = createGatewayCommand("/opt/openclaw/dist/index.js");
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(command);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
      runtimeNote: "Node 24.15.0: unsupported version, capability probe passed.",
    });

    await runRepair({ gateway: {} });

    expectNoteContaining("unsupported version, capability probe passed", "Gateway runtime");
    expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("skips service audit and rewrite for a non-default install identity", async () => {
    mocks.isDefaultInstallIdentity.mockReturnValue(false);

    await runRepair({ gateway: {} });

    expect(mocks.readCommand).not.toHaveBeenCalled();
    expect(mocks.auditGatewayServiceConfig).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expectNoteContaining(
      "service management skipped: non-default state dir or config path",
      "Gateway",
    );
  });

  it("reports an orphaned unsafe systemd backup without an active service command", async () => {
    mocks.readCommand.mockResolvedValue(null);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "systemd-unit-backup-unsafe",
          message: "Systemd service backup exposes gateway credentials.",
          detail: "/home/test/.config/systemd/user/openclaw-gateway.service.bak",
          level: "recommended",
        },
      ],
    });

    await runRepair({ gateway: {} });

    expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ command: null, platform: process.platform }),
    );
    expectNoteContaining(
      "Systemd service backup exposes gateway credentials",
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("treats gateway.auth.token as source of truth for service token repairs", async () => {
    setupGatewayTokenRepairScenario();

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "config-token",
        },
      },
    };

    await runRepair(cfg);

    expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", "config-token");
    expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "config-token");
    expect(mocks.writeConfig).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
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
      secrets: {
        providers: {
          execmain: {
            source: "exec",
            command: process.execPath,
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
    mocks.readCommand.mockResolvedValue({
      programArguments: [nvmNode, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
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

    await runRepair({ gateway: {} });

    const runtimeNotes = mocks.note.mock.calls.filter(([, title]) => title === "Gateway runtime");
    const runtimeMessages = runtimeNotes.map(([message]) => message);
    expect(runtimeMessages).not.toContain("duplicate doctor runtime warning");
    expect(runtimeMessages.map((message) => String(message)).join("\n")).not.toContain("not found");
    expect(runtimeMessages.map((message) => String(message)).join("\n")).toContain(
      "Using /home/test/.nvm/versions/node/v24.16.0/bin/node",
    );
  });

  it.each([false, true])(
    "reports failed Bun probes without runtime migration (other repairable drift: %s)",
    async (otherDrift) => {
      const bunCommand = {
        programArguments: ["/opt/bun", "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
        environment: {},
      };
      mocks.readCommand.mockResolvedValue(bunCommand);
      mocks.buildGatewayInstallPlan.mockResolvedValue(bunCommand);
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: false,
        issues: [
          {
            code: "gateway-runtime-probe-failed",
            message: "Gateway service Bun runtime probe failed.",
            detail: "/opt/bun (cwd /root): EACCES",
          },
          ...(otherDrift
            ? [{ code: "gateway-path-nonminimal", message: "Gateway PATH should be regenerated" }]
            : []),
        ],
      });
      const prompter = makeDoctorPrompts();

      await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
        writeConfig: mocks.writeConfig,
      });

      expectNoteContaining("/opt/bun (cwd /root): EACCES", "Gateway service config");
      expectNoNoteContaining("unsupported", "Gateway service config");
      expect(mocks.resolveSystemNodeInfo).not.toHaveBeenCalled();
      expect(prompter.confirmRuntimeRepair).toHaveBeenCalledTimes(Number(otherDrift));
      expect(mocks.install).toHaveBeenCalledTimes(Number(otherDrift));
      for (const [options] of mocks.buildGatewayInstallPlan.mock.calls) {
        expect(options).toEqual(
          expect.objectContaining({ runtime: "bun", runtimePath: "/opt/bun" }),
        );
      }
    },
  );

  registerDoctorRuntimePinTests({ mocks, runRepair, createRecommendedServiceAudit });

  it("migrates an unsupported Bun Gateway service to supported system Node", async () => {
    const bunPath = "/home/test/.bun/bin/bun";
    const systemNodePath = "/usr/bin/node";
    mocks.readCommand.mockResolvedValue({
      programArguments: [bunPath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
      programArguments: [runtimePath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
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

    await runRepair({ gateway: {} });

    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "node", runtimePath: systemNodePath }),
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({
        programArguments: [systemNodePath, "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
      }),
    );
  });

  it("passes planned managed env keys into service audit for legacy inline secret detection", async () => {
    mockProcessPlatform("linux");
    const managedDefinition = {
      programArguments: [
        "/usr/bin/node",
        "--max-old-space-size=24576",
        "--require=/tmp/service-preload.js",
        ...gatewayProgramArguments.slice(1),
      ],
      environment: { OPENCLAW_WRAPPER: "/managed-wrapper", TAVILY_API_KEY: "managed" },
      environmentValueSources: { TAVILY_API_KEY: "file" as const },
    };
    const existingCommand = {
      ...managedDefinition,
      environment: {
        OPENCLAW_WRAPPER: "/operator-wrapper",
        TAVILY_API_KEY: "old-inline-value",
        NODE_OPTIONS: "--max-old-space-size=512",
      },
      managedDefinition,
      managedOverrides: { environment: { keys: ["OPENCLAW_WRAPPER", "NODE_OPTIONS"] } },
    };
    mocks.readCommand.mockResolvedValue(existingCommand);
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-managed-env-embedded",
          message: "Gateway service embeds managed environment values that should load at runtime.",
          detail: "inline keys: TAVILY_API_KEY",
          environmentKeys: ["TAVILY_API_KEY"],
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: {} });

    expectCallField(
      mocks.auditGatewayServiceConfig,
      "expectedManagedServiceEnvKeys",
      new Set(["TAVILY_API_KEY"]),
    );
    for (const [plan] of mocks.buildGatewayInstallPlan.mock.calls) {
      expect(plan).toEqual(
        expect.objectContaining({
          existingCommand,
          existingEnvironment: managedDefinition.environment,
          existingEnvironmentValueSources: managedDefinition.environmentValueSources,
        }),
      );
    }
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  registerDoctorServiceDefaultsTests({
    mocks,
    gatewayProgramArguments,
    runRepair,
    mockProcessPlatform,
    expectNoNoteContaining,
  });

  it("repairs gateway services with embedded proxy environment values", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        HTTP_PROXY: "http://proxy.local:7890",
        HTTPS_PROXY: "https://proxy.local:7890",
      },
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-proxy-env-embedded",
          message: "Gateway service embeds proxy environment values that should not be persisted.",
          detail: "inline keys: HTTP_PROXY, HTTPS_PROXY",
          environmentKeys: ["HTTP_PROXY", "HTTPS_PROXY"],
          level: "recommended",
        },
      ],
    });
    mocks.install.mockResolvedValue(undefined);

    await runRepair({ gateway: {} });

    expect(mocks.install).toHaveBeenCalledOnce();
    const installOptions = requireRecord(callArg(mocks.install, 0, "gateway install"), "install");
    const environment = requireRecord(installOptions.environment, "install environment");
    expect(environment).toStrictEqual({});
    expect(Object.hasOwn(environment, "HTTP_PROXY")).toBe(false);
    expect(Object.hasOwn(environment, "HTTPS_PROXY")).toBe(false);
  });

  it("uses OPENCLAW_GATEWAY_TOKEN when config token is missing", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();

      const cfg: OpenClawConfig = {
        gateway: {},
      };

      await runRepair(cfg);

      expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", "env-token");
      expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "env-token");
      expectGatewayAuthToken(callArg(mocks.writeConfig, 0, "Doctor writer callback"), "env-token");
      expect(mocks.writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!,
      );
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.install).toHaveBeenCalledTimes(1);
    });
  });

  it("uses the persisted writer result when planning service installation", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
      setupGatewayTokenRepairScenario();
      mocks.writeConfig.mockImplementationOnce(async (nextConfig) => ({
        ...nextConfig,
        gateway: { ...nextConfig.gateway, auth: { mode: "token", token: "persisted-token" } },
      }));
      await runRepair({ gateway: {} });
      expectGatewayAuthToken(callArg(mocks.writeConfig, 0, "Doctor writer callback"), "env-token");
      expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "persisted-token");
      expect(mocks.writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!,
      );
      expect(mocks.install).toHaveBeenCalledOnce();
    });
  });

  it.each(["ordinary", "post-commit"] as const)(
    "stops service repair after a %s token persistence error",
    async (kind) => {
      await withEnvAsync({ OPENCLAW_GATEWAY_TOKEN: "env-token" }, async () => {
        setupGatewayTokenRepairScenario();
        const cfg: OpenClawConfig = { gateway: {} };
        const runtime = makeDoctorIo();
        const cause = new Error("token persistence failed");
        const failure =
          kind === "post-commit"
            ? new ConfigWritePostCommitError({
                configPath: "/tmp/openclaw.json",
                rollbackStatus: "not-restored",
                cause,
              })
            : cause;
        mocks.writeConfig.mockRejectedValueOnce(failure);

        const repair = maybeRepairGatewayServiceConfig(cfg, "local", runtime, makeDoctorPrompts(), {
          writeConfig: mocks.writeConfig,
        });
        if (kind === "post-commit") {
          await expect(repair).rejects.toBe(failure);
        } else {
          await expect(repair).resolves.toBe(cfg);
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to persist gateway.auth.token before service repair:"),
          );
        }
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      });
    },
  );

  it("does not flag entrypoint mismatch when symlink and realpath match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
      installEntrypoint:
        "/Users/test/Library/pnpm/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/dist/index.js",
      realpath: async (value: string) => {
        const normalized = value.replaceAll("\\", "/").replace(/^[A-Z]:/i, "");
        if (normalized.includes("/global/5/node_modules/openclaw/")) {
          return normalized.replace(
            "/global/5/node_modules/openclaw/",
            "/global/5/node_modules/.pnpm/openclaw@2026.3.12/node_modules/openclaw/",
          );
        }
        return normalized;
      },
    });

    await runRepair({ gateway: {} });

    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("does not flag entrypoint mismatch when realpath fails but normalized absolute paths match", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/opt/openclaw/../openclaw/dist/index.js",
      installEntrypoint: "/opt/openclaw/dist/index.js",
      realpathError: new Error("no realpath"),
    });

    await runRepair({ gateway: {} });

    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each([
    [
      "relative entrypoint",
      "dist/index.js",
      "/opt/openclaw",
      { launcher: "working-directory" },
      undefined,
    ],
    [
      "harmless environment with a managed token issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { keys: ["NODE_COMPILE_CACHE"] } },
      "gateway-token-mismatch",
    ],
    [
      "an operator-owned managed key with a different embedded managed key",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { keys: ["MANAGED_A"] } },
      "gateway-managed-env-embedded",
    ],
    [
      "a file reset with an inline token issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetFiles: true } },
      "gateway-token-mismatch",
    ],
    [
      "a file reset with an inline PATH issue",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetFiles: true } },
      "gateway-path-missing",
    ],
    [
      "a reset-only proxy removal",
      "/usr/local/bin/openclaw",
      undefined,
      { environment: { resetInline: true } },
      "gateway-proxy-env-embedded",
    ],
  ] as const)(
    "does not attribute unrelated repair issues to %s",
    async (_, entrypoint, directory, overrides, issue) => {
      mockProcessPlatform("linux");
      const embeddedManagedIssue = issue === "gateway-managed-env-embedded";
      const managedDefinition = {
        ...createGatewayCommand(entrypoint),
        environment: embeddedManagedIssue
          ? { MANAGED_B: "embedded-base-value" }
          : issue === "gateway-proxy-env-embedded"
            ? { HTTPS_PROXY: "http://proxy.local" }
            : issue === "gateway-path-missing"
              ? { PATH: "/managed/bin" }
              : issue
                ? { OPENCLAW_GATEWAY_TOKEN: "stale-token" }
                : {},
      };
      mocks.readCommand.mockResolvedValue({
        ...managedDefinition,
        workingDirectory: directory,
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
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: !issue,
        issues: issue
          ? [
              {
                code: issue,
                message: "repair",
                level: "recommended",
                environmentKeys: embeddedManagedIssue
                  ? ["MANAGED_B"]
                  : issue === "gateway-proxy-env-embedded"
                    ? ["HTTPS_PROXY"]
                    : undefined,
              },
            ]
          : [],
      });
      mocks.buildGatewayInstallPlan.mockResolvedValue({
        ...createGatewayCommand(directory ? path.join(directory, entrypoint) : entrypoint),
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
      expect(mocks.install).toHaveBeenCalledTimes(issue ? 1 : 0);
    },
  );

  it("keeps wrapper-managed gateway services aligned during entrypoint drift checks", async () => {
    const wrapperPath = "/usr/local/bin/openclaw-doppler";
    mocks.readCommand.mockResolvedValue({
      programArguments: [wrapperPath, "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_WRAPPER: wrapperPath,
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ env }) => ({
      programArguments: [env.OPENCLAW_WRAPPER, "gateway", "--port", "18789"],
      environment: {
        OPENCLAW_WRAPPER: env.OPENCLAW_WRAPPER,
      },
    }));

    await runRepair({ gateway: {} });

    const installPlanOptions = requireRecord(
      callArg(mocks.buildGatewayInstallPlan, 0, "buildGatewayInstallPlan call"),
      "buildGatewayInstallPlan options",
    );
    expect(requireRecord(installPlanOptions.env, "install env").OPENCLAW_WRAPPER).toBe(wrapperPath);
    expect(
      requireRecord(installPlanOptions.existingEnvironment, "install existing environment")
        .OPENCLAW_WRAPPER,
    ).toBe(wrapperPath);
    expectNoNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      "Gateway service invokes OPENCLAW_WRAPPER: /usr/local/bin/openclaw-doppler",
      "Gateway",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("still flags entrypoint mismatch when canonicalized paths differ", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint:
        "/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/openclaw/dist/index.js",
      installEntrypoint: "/Users/test/Library/pnpm/global/5/node_modules/openclaw/dist/index.js",
    });

    await runRepair({ gateway: {} });

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("skips entrypoint rewrites for an active systemd unit", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      ...createGatewayCommand("/opt/old-openclaw/dist/index.js"),
      sourcePath: "/etc/systemd/system/custom-gateway.service",
      managedDefinition: createGatewayCommand("/opt/new-openclaw/dist/index.js"),
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(ok(true));

    await runRepair({ gateway: {} });

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "system",
    );
    expectNoteContaining("skipped command/entrypoint rewrites", "Gateway service config");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it.each([
    ["command", { launcher: "command" as const }, "gateway-port-mismatch"],
    ["directory", { launcher: "working-directory" as const }, "gateway-entrypoint-mismatch"],
    ["environment", { environment: { keys: ["tavily_api_key"] } }, "gateway-managed-env-embedded"],
    ["lowercase proxy", { environment: { keys: ["https_proxy"] } }, "gateway-proxy-env-embedded"],
    ["file-backed token reset", { environment: { resetFiles: true } }, "gateway-token-mismatch"],
    [
      "file-backed managed reset",
      { environment: { resetFiles: true } },
      "gateway-managed-env-embedded",
    ],
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
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: false,
        issues: [
          {
            code: issue,
            message: "repair",
            level: "recommended",
            environmentKeys:
              issue === "gateway-proxy-env-embedded" ? ["https_proxy"] : ["TAVILY_API_KEY"],
          },
        ],
      });
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

      await runRepair({ gateway: {} });

      expectNoteContaining("operator-owned systemd drop-in", "Gateway service config");
      expectNoteContaining("systemctl --user cat custom-gateway.service", "Gateway service config");
      expect(mocks.writeConfig).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );

  it("repairs entrypoint drift when the systemd unit is stopped", async () => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      ...createGatewayCommand("/opt/old-openclaw/dist/index.js"),
      sourcePath: "/home/test/.config/systemd/user/custom-gateway.service",
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: true,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      ...createGatewayCommand("/opt/new-openclaw/dist/index.js"),
      workingDirectory: "/tmp",
    });
    mocks.isSystemdUnitActive.mockResolvedValue(ok(false));

    await runRepair({ gateway: {} });

    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      "user",
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it.each([
    ["active", ok(true)],
    ["bus query failed", err("Failed to connect to bus: Permission denied")],
  ] satisfies [string, Result<boolean, string>][])(
    "leaves service metadata unchanged when unit activity is %s and command drift accompanies other issues",
    async (_, active) => {
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
      mocks.isSystemdUnitActive.mockResolvedValue(active);

      await runRepair({ gateway: { port: 18888 } });

      expectNoteContaining(
        "Gateway service port does not match current gateway config.",
        "Gateway service config",
      );
      expectNoteContaining("supervisor metadata unchanged", "Gateway service config");
      if (active.ok) {
        expectNoteContaining(
          "is running; skipped command/entrypoint rewrites",
          "Gateway service config",
        );
        expectNoNoteContaining("Service command does not include", "Gateway service config");
      } else {
        expectNoteContaining("Service command does not include", "Gateway service config");
        expectNoteContaining(active.error, "Gateway service config");
        expectNoteContaining(
          "systemctl --user status openclaw-gateway.service",
          "Gateway service config",
        );
        expectNoNoteContaining("is running;", "Gateway service config");
      }
      expect(mocks.writeConfig).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );

  it("skips entrypoint rewrite in non-interactive fix mode", async () => {
    setupGatewayEntrypointRepairScenario({
      currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
      installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
      installWorkingDirectory: "/tmp",
    });

    await runNonInteractiveRepair({
      cfg: { gateway: {} },
      updateInProgress: false,
    });

    expectNoteContaining(
      "Gateway service entrypoint does not match the current install.",
      "Gateway service config",
    );
    expectNoteContaining("openclaw gateway install --force", "Gateway service config");
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each(
    (["linux", "darwin", "win32"] as const).flatMap((platform) =>
      [false, true].flatMap((force) =>
        [false, true].map((parentGrant) => ({ platform, force, parentGrant })),
      ),
    ),
  )(
    "leaves $platform update repair with finalization (force=$force, parent grant=$parentGrant)",
    async ({ platform, force, parentGrant }) => {
      mockProcessPlatform(platform);
      await withEnvAsync(
        {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: parentGrant ? "1" : undefined,
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: parentGrant ? "1" : undefined,
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: parentGrant ? "1" : undefined,
          OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: parentGrant ? "1" : undefined,
        },
        async () => {
          setupGatewayTokenRepairScenario();
          mocks.readRuntime.mockResolvedValue({ status: "running" });
          await runNonInteractiveRepair({ updateInProgress: true, force });
          expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledOnce();
          expect(mocks.stage).not.toHaveBeenCalled();
          expect(mocks.install).not.toHaveBeenCalled();
          expect(mocks.restart).not.toHaveBeenCalled();
          expect(mocks.writeConfig).not.toHaveBeenCalled();
          expectNoteContaining("deferred to update finalization", "Gateway service config");
        },
      );
    },
  );

  it("treats SecretRef-managed gateway token as non-persisted service state", async () => {
    mocks.readCommand.mockResolvedValue({
      programArguments: gatewayProgramArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-token",
      },
    });
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [],
    });
    mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
    mocks.install.mockResolvedValue(undefined);

    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN",
          },
        },
      },
    };

    await runRepair(cfg);

    expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", undefined);
    expectCallField(mocks.buildGatewayInstallPlan, "config", cfg);
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it("falls back to embedded service token when config and env tokens are missing", async () => {
    mockProcessPlatform("linux");
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        setupGatewayTokenRepairScenario();
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: { OPENCLAW_GATEWAY_TOKEN: "stale-token" },
        });

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expectCallField(mocks.auditGatewayServiceConfig, "expectedGatewayToken", undefined);
        expectGatewayAuthToken(
          callArg(mocks.writeConfig, 0, "Doctor writer callback"),
          "stale-token",
        );
        expect(mocks.writeConfig.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.install.mock.invocationCallOrder[0]!,
        );
        expectCallConfigGatewayAuthToken(mocks.buildGatewayInstallPlan, "stale-token");
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("does not persist EnvironmentFile-backed service tokens into config", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
      },
      async () => {
        mocks.readCommand.mockResolvedValue({
          programArguments: gatewayProgramArguments,
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "env-file-token",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        });
        mocks.auditGatewayServiceConfig.mockResolvedValue({
          ok: false,
          issues: [],
        });
        mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayInstallPlanFixture());
        mocks.install.mockResolvedValue(undefined);

        const cfg: OpenClawConfig = {
          gateway: {},
        };

        await runRepair(cfg);

        expect(mocks.writeConfig).not.toHaveBeenCalled();
        expectCallField(mocks.buildGatewayInstallPlan, "config", cfg);
        expect(mocks.stage).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY", "OPENCLAW_SUPERVISOR_MODE"])(
    "reports service config drift but skips repair when %s is external",
    async (envKey) => {
      await withEnvAsync({ [envKey]: "external" }, async () => {
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/entry.js",
          installEntrypoint: "/Users/test/Library/npm/node_modules/openclaw/dist/index.js",
          installWorkingDirectory: "/tmp",
        });
        const prompter = makeDoctorPrompts();

        await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
          writeConfig: mocks.writeConfig,
        });

        expect(mocks.auditGatewayServiceConfig).toHaveBeenCalledOnce();
        expectNoteContaining(
          "Gateway service entrypoint does not match the current install.",
          "Gateway service config",
        );
        expect(mocks.note).toHaveBeenCalledWith(
          formatServiceRepairDeferredNote("external"),
          "Gateway service config",
        );
        expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
        expect(mocks.writeConfig).not.toHaveBeenCalled();
        expect(mocks.stage).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
      });
    },
  );

  it("warns when the gateway service entrypoint resolves to a source checkout", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-service-layout-"));
      try {
        await fs.mkdir(path.join(root, ".git"), { recursive: true });
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, "extensions"), { recursive: true });
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
          "utf8",
        );
        const entrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(entrypoint, "export {};\n", "utf8");
        mocks.readCommand.mockResolvedValue(createGatewayCommand(entrypoint));
        mocks.auditGatewayServiceConfig.mockResolvedValue({ ok: true, issues: [] });
        mocks.buildGatewayInstallPlan.mockResolvedValue(createGatewayCommand(entrypoint));

        await runRepair({ gateway: {} });

        expectNoteContaining("resolves to a source checkout", "Gateway service config");
        expectNoteContaining(
          "Run `openclaw gateway install --force` from the intended package install to replace the gateway service definition.",
          "Gateway service config",
        );
        expectNoNoteContaining("openclaw doctor --fix", "Gateway service config");
        expect(mocks.install).not.toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("does not duplicate Gateway service config panels for a source-checkout entrypoint with audit findings", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-doctor-service-config-dedup-"),
      );
      try {
        await fs.mkdir(path.join(root, ".git"), { recursive: true });
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, "extensions"), { recursive: true });
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
          "utf8",
        );
        const sourceCheckoutEntrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(sourceCheckoutEntrypoint, "export {};\n", "utf8");
        const installEntrypoint = "/usr/local/lib/node_modules/openclaw/dist/index.js";
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: sourceCheckoutEntrypoint,
          installEntrypoint,
          installWorkingDirectory: "/tmp",
        });

        await runRepair({ gateway: {} });

        const gatewayServiceConfigNotes = mocks.note.mock.calls.filter(
          ([, title]) => title === "Gateway service config",
        );
        expect(gatewayServiceConfigNotes).toHaveLength(1);
        const consolidated = gatewayServiceConfigNotes[0]?.[0] ?? "";
        expect(consolidated).toContain(
          "Gateway service entrypoint does not match the current install.",
        );
        expect(consolidated).not.toContain("resolves to a source checkout");
        const forceMatches = consolidated.match(/openclaw gateway install --force/g) ?? [];
        expect(forceMatches).toHaveLength(0);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  it("keeps the gateway install force hint when a source-checkout warning is suppressed and repair is declined", async () => {
    await withEnvAsync({}, async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-doctor-service-config-force-hint-"),
      );
      try {
        await fs.mkdir(path.join(root, ".git"), { recursive: true });
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, "extensions"), { recursive: true });
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
          "utf8",
        );
        const sourceCheckoutEntrypoint = path.join(root, "dist", "index.js");
        await fs.writeFile(sourceCheckoutEntrypoint, "export {};\n", "utf8");
        const installEntrypoint = "/usr/local/lib/node_modules/openclaw/dist/index.js";
        setupGatewayEntrypointRepairScenario({
          currentEntrypoint: sourceCheckoutEntrypoint,
          installEntrypoint,
          installWorkingDirectory: "/tmp",
        });

        const declinePrompts = {
          ...makeDoctorPrompts(),
          confirmAutoFix: vi.fn().mockResolvedValue(false),
          confirmAggressiveAutoFix: vi.fn().mockResolvedValue(false),
          confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
        };
        await maybeRepairGatewayServiceConfig(
          { gateway: {} },
          "local",
          makeDoctorIo(),
          declinePrompts,
          { writeConfig: mocks.writeConfig },
        );

        const gatewayServiceConfigNotes = mocks.note.mock.calls.filter(
          ([, title]) => title === "Gateway service config",
        );
        expect(gatewayServiceConfigNotes).toHaveLength(2);
        const auditNote = gatewayServiceConfigNotes[0]?.[0] ?? "";
        expect(auditNote).toContain(
          "Gateway service entrypoint does not match the current install.",
        );
        expect(auditNote).not.toContain("resolves to a source checkout");
        expect(gatewayServiceConfigNotes[1]?.[0]).toContain("openclaw gateway install --force");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
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
    mocks.findSystemdGatewayInstallation.mockResolvedValue({ kind: "none" });
    mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  afterEach(() => {
    mockProcessPlatform(originalPlatform);
    delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
  });

  it("removes the user-scope unit and keeps the system unit when confirmed", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.uninstallUserSystemdGatewayUnit.mockResolvedValue({
      unitName: "openclaw-gateway.service",
      unitPath: duelingInstallation.user.unitPath,
      removed: true,
      disabled: true,
    });
    const runtime = makeDoctorIo();
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(runtime, prompter);

    expect(mocks.uninstallUserSystemdGatewayUnit).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Cleanup of openclaw-gateway.service completed."),
    );
  });

  it("emits cleanup hints and does not remove anything when declined", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
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

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY", "OPENCLAW_SUPERVISOR_MODE"])(
    "skips removal and repair confirmation when %s is external",
    async (envKey) => {
      mockProcessPlatform("linux");
      mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
      mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
      const prompter = makeDoctorPrompts();

      await withEnvAsync({ [envKey]: "external" }, async () => {
        await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);
      });

      expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
      expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
      expect(mocks.note).toHaveBeenCalledWith(
        formatServiceRepairDeferredNote("external"),
        "Gateway cleanup skipped",
      );
    },
  );

  it("keeps the user unit when the system unit is enabled but not running", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(false);
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not verify the system-scope unit is both running and enabled at boot",
      ),
      "Gateway cleanup needs an owner decision",
    );
  });

  it("tells the operator to stop the unit when systemctl could not disable it", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockResolvedValue(true);
    mocks.uninstallUserSystemdGatewayUnit.mockResolvedValue({
      unitName: "openclaw-gateway.service",
      unitPath: duelingInstallation.user.unitPath,
      removed: true,
      disabled: false,
    });
    const runtime = makeDoctorIo();

    await maybeResolveDuelingSystemdGatewayScopes(runtime, makeDoctorPrompts());

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("systemctl --user disable --now openclaw-gateway.service"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("sole gateway manager"));
  });

  it("fails closed when the system unit ownership probe errors", async () => {
    mockProcessPlatform("linux");
    mocks.findSystemdGatewayInstallation.mockResolvedValue(duelingInstallation);
    mocks.isSystemUnitActiveAndEnabled.mockRejectedValue(new Error("systemctl wedged"));
    const prompter = makeDoctorPrompts();

    await maybeResolveDuelingSystemdGatewayScopes(makeDoctorIo(), prompter);

    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.uninstallUserSystemdGatewayUnit).not.toHaveBeenCalled();
  });

  it("does nothing for a single-scope (user-only) install", async () => {
    mockProcessPlatform("linux");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
