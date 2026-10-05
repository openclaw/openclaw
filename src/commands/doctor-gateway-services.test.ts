import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
// Doctor gateway service tests cover service audit diagnostics and duplicate gateway service reporting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
    runtime: "node",
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

  it.each([false])(
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
      mocks.auditGatewayServiceConfig.mockResolvedValue({
        ok: !issue,
        issues: issue
          ? [
              {
                code: issue,
                message: "repair",
                level: "recommended",
                environmentKeys: embeddedManagedIssue ? ["MANAGED_B"] : undefined,
              },
            ]
          : [],
      });
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
      expect(mocks.install).toHaveBeenCalledTimes(issue ? 1 : 0);
    },
  );

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

  it.each([["bus query failed", err("Failed to connect to bus: Permission denied")]] satisfies [
    string,
    Result<boolean, string>,
  ][])(
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
        expect(mocks.buildGatewayInstallPlan).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ config: cfg }),
        );
        expect(mocks.stage).not.toHaveBeenCalled();
      },
    );
  });

  it.each(["OPENCLAW_SERVICE_REPAIR_POLICY"])(
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

  it.each(["OPENCLAW_SUPERVISOR_MODE"])(
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
