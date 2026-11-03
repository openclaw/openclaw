import { describe, expect, it, vi } from "vitest";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  DOCTOR_GATEWAY_HEALTH_ID,
  requireDoctorContribution,
  requireDoctorHealthCheck,
  createDoctorContext,
  createDoctorLintFixture,
} from "./doctor-health-contributions-suite.test-support.js";
import {
  createDoctorConfigFixture,
  createDoctorHealthFlowContext,
  createDoctorLintContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck } from "./health-checks.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  it("defers gateway probes while Doctor owns offline maintenance", async () => {
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      env: {},
    });
    ctx.gatewayMaintenanceActive = true;
    await contribution.run(ctx);
    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("skips read-scope gateway probes when gateway health only proved reachability", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {} },
      cfgForPersistence: {},
      env: {},
    });

    await contribution.run(ctx);

    expect(ctx.healthOk).toBe(true);
    expect(ctx.gatewayHealthAuthenticated).toBe(false);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
    expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
  });

  it("skips remote gateway health probes for local fallback exec SecretRefs", async () => {
    mocks.checkGatewayHealth.mockResolvedValue({
      authenticated: false,
      healthOk: true,
      status: { ok: true },
    });
    mocks.gatewaySecretInputPathCanWin.mockImplementation(
      ({ path }: { path: string }) => path === "gateway.auth.token",
    );
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
    const contribution = requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID);
    const cfg = createDoctorConfigFixture({
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example",
        },
        auth: {
          mode: "token",
          token: { source: "exec", provider: "vault", id: "gateway/token" },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: "/bin/false" },
        },
      },
    });
    const ctx = createDoctorContext({ cfg, env: {} });

    await contribution.run(ctx);

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway health checks skipped"),
      "Gateway",
    );
    expect(ctx.gatewayHealthSkipped).toBe(true);
    expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
  });

  it("keeps release configured plugin installs repair-only", async () => {
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(false),
      env: {},
    });

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("stamps release configured plugin installs after repair changes", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
      pluginInventoryChanged: true,
    });
    const invalidatePluginMetadataSnapshot = vi.fn();
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.4.29" },
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(true),
      env: {},
      invalidatePluginMetadataSnapshot,
    });

    await contribution.run(ctx);

    expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
      cfg: {},
      env: {},
      touchedVersion: "2026.4.29",
    });
    expect(mocks.note).toHaveBeenCalledWith(
      "Installed configured plugin matrix.",
      "Doctor changes",
    );
    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
    expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps legacy parent writable release repairs old-parent-readable", async () => {
    mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
      changes: ["Installed configured plugin matrix."],
      warnings: [],
      touchedConfig: true,
    });
    const contribution = requireDoctorContribution("doctor:release-configured-plugin-installs");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: { cfg: {}, sourceLastTouchedVersion: "2026.5.16-beta.4" },
      cfgForPersistence: {},
      shouldRepair: true,
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      },
    });

    await contribution.run(ctx);

    expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.16-beta.4");
    expect(readConfigMachineState<string>("config.lastTouchedAt")).toEqual(expect.any(String));
  });

  it("runs the web fetch proxy diagnostic after security checks", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const contribution = requireDoctorContribution("doctor:web-fetch-proxy");
    const cfg = { gateway: { mode: "local" as const } };
    const env = { HTTPS_PROXY: "http://proxy.example:8080" };
    const ctx = createDoctorHealthFlowContext({ cfg, env });

    expect(ids.indexOf("doctor:security")).toBeLessThan(ids.indexOf("doctor:web-fetch-proxy"));
    await contribution.run(ctx);

    expect(mocks.noteWebFetchProxyDiagnostic).toHaveBeenCalledWith({ cfg, env });
  });

  it("keeps workspace status opt-in for structured lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/workspace-status"]);
    expect(check.defaultEnabled).toBe(false);

    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm" as const,
          spec: "@openclaw/codex@2026.5.30-beta.1",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionRestartReadiness: {
        status: "resolved",
        report: pluginVersionDrift,
        runningGatewayVersion: "2026.6.1",
      },
    });
    mocks.collectWorkspaceStatusHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        message: "Plugin codex is stale.",
        path: "plugins.entries.codex",
      },
    ]);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      version: null,
      nodeEngine: null,
      error: "HTTP 404",
    });
    const ctx = createDoctorLintContext({
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
      mode: "lint",
      allowExecSecretRefs: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(mocks.collectWorkspaceStatusHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks: [check], onlyIds: ["core/doctor/workspace-status"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/workspace-status" })],
    });
    expect(mocks.collectWorkspaceStatusHealthFindings).toHaveBeenCalledWith(ctx.cfg, {
      pluginVersionReadiness: {
        status: "resolved",
        report: {
          ...pluginVersionDrift,
          drifts: [
            {
              ...pluginVersionDrift.drifts[0],
              targetResolution: expect.objectContaining({
                status: "unresolved",
                error: expect.stringContaining("HTTP 404"),
              }),
            },
          ],
        },
        runningGatewayVersion: "2026.6.1",
      },
    });
    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledWith({
      packageName: "@openclaw/codex",
      target: "2026.6.1",
    });
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: {
        timeout: "3000",
        json: true,
      },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: true,
      pluginVersionTarget: "restart",
    });
  });

  it("omits plugin readiness when status fails before applicability is known", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    mocks.gatherDaemonStatus.mockRejectedValueOnce(new Error("service inspection failed"));
    const cfg = {};

    await contribution.run(createDoctorHealthFlowContext({ cfg }));

    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionReadiness: undefined,
    });
  });

  it("skips daemon-context plugin drift probes for remote gateway mode", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const cfg = {
      gateway: { mode: "remote" },
      plugins: { entries: { codex: { enabled: true } } },
    };

    await contribution.run({
      cfg,
      options: { nonInteractive: true },
    } as unknown as Parameters<(typeof contribution)["run"]>[0]);

    expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
    expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
      pluginVersionReadiness: undefined,
    });
  });

  it("uses the read-only model catalog for hooks.gmail.model warnings", async () => {
    const contribution = requireDoctorContribution("doctor:hooks-model");
    const cfg = {
      hooks: {
        gmail: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const ctx = createDoctorHealthFlowContext({
      cfg,
      options: {},
    });

    await contribution.run(ctx);

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      readOnly: true,
      providerDiscoveryProviderIds: [],
    });
  });

  it("materializes heartbeat cadence before scratch migration and final config writes", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const cadenceIndex = ids.indexOf("doctor:heartbeat-cadence-migration");
    const scratchIndex = ids.indexOf("doctor:heartbeat-scratch-migration");

    expect(cadenceIndex).toBeGreaterThan(-1);
    expect(cadenceIndex).toBeLessThan(scratchIndex);
    expect(scratchIndex).toBeLessThan(ids.indexOf("doctor:write-config"));

    const contribution = requireDoctorContribution("doctor:heartbeat-cadence-migration");
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        prompter: createDoctorPrompterFixture(true),
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      }),
    );

    expect(mocks.maybeMigrateHeartbeatCadenceToCron).toHaveBeenCalledWith({
      cfg,
      shouldRepair: true,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });
  });

  it("forwards the health-check environment to heartbeat cadence detection", async () => {
    const check = await requireDoctorHealthCheck("core/doctor/heartbeat-cadence-migration");
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-detector-state" };

    await check!.detect(createDoctorLintFixture(cfg, { env }));

    expect(mocks.collectHeartbeatCadenceMigrationFindings).toHaveBeenCalledWith(cfg, env);
  });

  it("forwards the health-check environment to heartbeat task detection", async () => {
    const check = await requireDoctorHealthCheck("core/doctor/heartbeat-task-cron-migration");
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-task-detector-state" };

    await check!.detect(createDoctorLintFixture(cfg, { env }));

    expect(mocks.collectHeartbeatTaskMigrationFindings).toHaveBeenCalledWith(cfg, env);
  });

  it("includes opt-in default-account diagnostics when all checks are requested", async () => {
    const contribution = requireDoctorContribution("doctor:default-account-routing");
    const check = contribution.healthChecks[0] as HealthCheck | undefined;
    expect(check).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture(
      createDoctorConfigFixture({
        channels: {
          telegram: {
            accounts: {
              alerts: {},
              work: {},
            },
          },
        },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      }),
    );

    await expect(
      runDoctorLintChecks(ctx, { checks: [check!], includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
      ],
    });
  });

  it("preserves allow-exec Gateway SecretRef resolution in auth health", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-auth");
    const ctx = createDoctorContext({
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: "exec-token" },
        },
      },
      options: { allowExec: true, nonInteractive: true },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: "1" },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    expect(mocks.resolveGatewayAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        env: ctx.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Gateway token SecretRef could not be resolved: exec provider failed",
      ),
      "Gateway auth",
    );
  });

  it("regenerates an invalid Gateway token", async () => {
    const token = "undefined";
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "token", token });
    mocks.resolveGatewayAuthToken.mockResolvedValue({ source: "config", token });
    const contribution = requireDoctorContribution("doctor:gateway-auth");
    const ctx = createDoctorContext({
      cfg: {
        gateway: {
          mode: "local",
          auth: { mode: "token", token },
        },
      },
      options: { generateGatewayToken: true, nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("not a usable secret"),
      "Gateway auth",
    );
    expect(ctx.cfg.gateway?.auth?.token).toBe("generated-gateway-token");
  });

  it("preserves password auth during placeholder repair", async () => {
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "password", token: "undefined" });
    const original = {
      mode: "password" as const,
      token: "undefined",
      password: "synthetic-password",
    };
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local", auth: original } },
      options: { generateGatewayToken: true, nonInteractive: true },
    });
    await requireDoctorContribution("doctor:gateway-auth").run(ctx);
    expect(ctx.cfg.gateway?.auth).toEqual(original);
  });

  it("silently skips the host-service contribution in a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue(null);
    const contribution = requireDoctorContribution("doctor:gateway-services");
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local" } },
      configResult: {},
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: {},
    });

    await contribution.run(ctx);

    expect(mocks.maybeScanExtraGatewayServices).not.toHaveBeenCalled();
    expect(mocks.maybeResolveDuelingSystemdGatewayScopes).not.toHaveBeenCalled();
    expect(mocks.maybeRepairGatewayServiceConfig).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });
});
