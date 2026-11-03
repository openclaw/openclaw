import fs from "node:fs";
import nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  requireDoctorContribution,
  requireDoctorHealthCheck,
  createDoctorContext,
  createDoctorLintFixture,
} from "./doctor-health-contributions-suite.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  it("keeps stale plugin-runtime symlinks opt-in for structured lint selection", async () => {
    const check = await requireDoctorHealthCheck("core/doctor/stale-plugin-runtime-symlinks");
    expect(check).toMatchObject({ defaultEnabled: false });
    mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/stale-plugin-runtime-symlinks",
        severity: "warning",
        message: "Stale plugin-runtime symlink left-pad points at plugin-runtime-deps.",
        path: "/tmp/node_modules/left-pad",
        target: "/tmp/node_modules/left-pad",
      },
    ]);

    const ctx = createDoctorLintFixture();

    expect(mocks.collectStalePluginRuntimeSymlinkHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, {
        checks: [check!],
        onlyIds: ["core/doctor/stale-plugin-runtime-symlinks"],
      }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/stale-plugin-runtime-symlinks",
          path: "/tmp/node_modules/left-pad",
        }),
      ],
    });
    expect(mocks.collectStalePluginRuntimeSymlinkHealthFindings).toHaveBeenCalledTimes(1);
  });

  it("preserves the shipped legacy dependency selector as a non-destructive deprecation", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-legacy-plugin-deps-lint-",
    });
    const stateDir = openClawState.stateDir;
    const legacyRuntimeRoot = nodePath.join(stateDir, "plugin-runtime-deps");
    fs.mkdirSync(legacyRuntimeRoot, { recursive: true });
    try {
      const check = await requireDoctorHealthCheck("core/doctor/legacy-plugin-dependencies");
      expect(check).toMatchObject({ defaultEnabled: false });

      const ctx = createDoctorLintFixture();

      await expect(
        runDoctorLintChecks(ctx, {
          checks: [check!],
          onlyIds: ["core/doctor/legacy-plugin-dependencies"],
        }),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/legacy-plugin-dependencies",
            severity: "info",
            message:
              "Deprecated check: Doctor preserves shared plugin runtime caches and no longer scans them for removal.",
          }),
        ],
      });
      expect(fs.existsSync(legacyRuntimeRoot)).toBe(true);
    } finally {
      await openClawState.cleanup();
    }
  });

  it("collects memory-search findings from the diagnostic owner", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const check = contribution.healthChecks[0] as HealthCheck;
    const ctx = createDoctorLintFixture(
      {},
      { env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" } },
    );
    const findings: HealthFinding[] = [
      {
        checkId: "core/doctor/memory-search",
        severity: "warning",
        path: "memory.search.provider",
        message: 'Memory search provider is set to "openai" but no API key was found.',
        fixHint: "- Set OPENAI_API_KEY in your environment",
      },
    ];
    mocks.collectMemorySearchHealthFindings.mockResolvedValueOnce(findings);

    expect(await check.detect(ctx)).toEqual(findings);
    expect(contribution.healthCheckIds).toEqual(["core/doctor/memory-search"]);
    expect((check as HealthCheck & { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
    expect(mocks.collectMemorySearchHealthFindings).toHaveBeenCalledWith(ctx);
    expect(mocks.noteMemorySearchHealth).not.toHaveBeenCalled();
  });

  it("forwards the interactive Doctor environment to memory provider discovery", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const env = { OPENCLAW_STATE_DIR: "/interactive-memory-state" };

    await contribution.run(createDoctorContext({ env }));

    expect(mocks.noteMemorySearchHealth).toHaveBeenCalledWith({}, expect.objectContaining({ env }));
  });

  it("keeps workspace suggestions opt-in for default lint selection", async () => {
    const workspaceSuggestionsCheck = await requireDoctorHealthCheck(
      "core/doctor/workspace-suggestions",
    );
    expect(workspaceSuggestionsCheck).toMatchObject({ defaultEnabled: false });
    mocks.collectWorkspaceBackupTip.mockReturnValueOnce(
      "Back up your workspace before major repair work.",
    );

    const ctx = createDoctorLintFixture();
    const checks = [workspaceSuggestionsCheck!];

    expect(mocks.collectWorkspaceBackupTip).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/workspace-suggestions"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/workspace-suggestions",
          severity: "info",
          message: "Back up your workspace before major repair work.",
        }),
      ],
    });
    expect(mocks.collectWorkspaceBackupTip).toHaveBeenCalledWith("/tmp/openclaw-workspace");
  });

  it("labels normal workspace suggestions for secondary agents", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-suggestions");
    const cfg = {} as OpenClawConfig;
    const ctx = createDoctorContext({ cfg, env: {} });
    mocks.listAgentIds.mockReturnValue(["default", "secondary"]);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    mocks.collectWorkspaceBackupTip.mockImplementation((workspaceDir) =>
      workspaceDir === "/tmp/secondary" ? "- Back up this workspace." : undefined,
    );
    mocks.shouldSuggestMemorySystem.mockImplementation(
      async (workspaceDir) => workspaceDir === "/tmp/secondary",
    );

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenCalledWith(
      'Agent "secondary": - Back up this workspace.',
      "Workspace",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      'Agent "secondary": Enable memory system for better recall.',
      "Workspace",
    );
    expect(mocks.note).toHaveBeenCalledTimes(2);
  });

  it("keeps single-agent workspace suggestion wording unchanged", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-suggestions");
    const cfg = {} as OpenClawConfig;
    const ctx = createDoctorContext({ cfg, env: {} });
    mocks.collectWorkspaceBackupTip.mockReturnValue("- Back up this workspace.");
    mocks.shouldSuggestMemorySystem.mockResolvedValue(true);

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenNthCalledWith(1, "- Back up this workspace.", "Workspace");
    expect(mocks.note).toHaveBeenNthCalledWith(
      2,
      "Enable memory system for better recall.",
      "Workspace",
    );
  });

  it("keeps disk space opt-in for default lint selection", async () => {
    const diskSpaceCheck = await requireDoctorHealthCheck("core/doctor/disk-space");
    expect(diskSpaceCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture();
    const checks = [diskSpaceCheck!];

    expect(mocks.collectDiskSpaceHealthFindings).not.toHaveBeenCalled();

    mocks.collectDiskSpaceHealthFindings.mockReturnValueOnce([
      {
        checkId: "core/doctor/disk-space",
        severity: "warning",
        message: "Low disk space: 300 MB free on the partition containing ~/.openclaw.",
        path: "/home/test/.openclaw",
        requirement: "low-free-space",
      },
    ]);

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/disk-space"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/disk-space" })],
    });
    expect(mocks.collectDiskSpaceHealthFindings).toHaveBeenCalledWith();
  });

  it("keeps WhatsApp responsiveness opt-in for default lint selection", async () => {
    const whatsappCheck = await requireDoctorHealthCheck("core/doctor/whatsapp-responsiveness");
    expect(whatsappCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture(
      { channels: { whatsapp: { enabled: true } } },
      { allowExecSecretRefs: true },
    );
    const checks = [whatsappCheck!];

    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).not.toHaveBeenCalled();

    const status = {
      eventLoop: {
        degraded: true,
        degradedSinceMs: 61_000,
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        delayP99Ms: 42,
        delayMaxMs: 12_000,
        utilization: 0.3,
        cpuCoreRatio: 0.4,
      },
    };
    mocks.callGateway.mockResolvedValueOnce(status);
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([
      {
        checkId: "core/doctor/whatsapp-responsiveness",
        severity: "warning",
        message: "Gateway event loop is degraded while local TUI clients are running.",
        path: "channels.whatsapp",
        requirement: "local-tui-event-loop-pressure",
      },
    ]);

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/whatsapp-responsiveness" })],
    });
    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      config: ctx.cfg,
      deviceIdentity: null,
    });
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status,
    });

    mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([]);
    const error = vi.fn();
    await expect(
      runDoctorLintChecks(
        {
          ...ctx,
          runtime: { log: vi.fn(), error, exit: vi.fn() },
        },
        { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] },
      ),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [],
    });
    expect(error).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenLastCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("skips WhatsApp responsiveness Gateway status probes for exec SecretRefs without allow-exec", async () => {
    const whatsappCheck = await requireDoctorHealthCheck("core/doctor/whatsapp-responsiveness");
    mocks.gatewaySecretInputPathCanWin.mockReturnValue(true);
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");

    const ctx = createDoctorLintFixture({ channels: { whatsapp: { enabled: true } } });
    const checks = [whatsappCheck!];

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/whatsapp-responsiveness"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [],
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("keeps device pairing opt-in for default lint selection", async () => {
    const devicePairingCheck = await requireDoctorHealthCheck("core/doctor/device-pairing");
    expect(devicePairingCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });
    const checks = [devicePairingCheck!];
    expect(mocks.collectDevicePairingHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/device-pairing"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
    });
    expect(mocks.collectDevicePairingHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      healthOk: false,
      env: ctx.env,
    });
  });

  it("keeps legacy cron store opt-in for default lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-cron");
    expect(contribution.healthCheckIds).toEqual([
      "core/doctor/legacy-whatsapp-crontab",
      "core/doctor/legacy-cron-store",
    ]);

    const cronStoreCheck = await requireDoctorHealthCheck("core/doctor/legacy-cron-store");
    expect(cronStoreCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture({ cron: { store: "/tmp/openclaw-cron/jobs.json" } });
    const checks = [cronStoreCheck!];

    expect(mocks.collectLegacyCronStoreHealthFindings).not.toHaveBeenCalled();

    mocks.collectLegacyCronStoreHealthFindings.mockResolvedValueOnce([
      {
        checkId: "core/doctor/legacy-cron-store",
        severity: "warning",
        message: "Legacy JSON cron store was found.",
        path: "/tmp/openclaw-cron/jobs.json",
        requirement: "legacy-cron-store",
      },
    ]);
    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/legacy-cron-store"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [expect.objectContaining({ checkId: "core/doctor/legacy-cron-store" })],
    });
    expect(mocks.collectLegacyCronStoreHealthFindings).toHaveBeenCalledWith({ cfg: ctx.cfg });
  });

  it("keeps legacy WhatsApp crontab opt-in for default lint selection", async () => {
    const crontabCheck = await requireDoctorHealthCheck("core/doctor/legacy-whatsapp-crontab");
    expect(crontabCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture();
    const checks = [crontabCheck!];

    expect(mocks.collectLegacyWhatsAppCrontabHealthWarning).not.toHaveBeenCalled();

    mocks.collectLegacyWhatsAppCrontabHealthWarning.mockResolvedValueOnce(
      "Legacy WhatsApp crontab health check detected.\nRemove the stale crontab entry.",
    );

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/legacy-whatsapp-crontab"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/legacy-whatsapp-crontab",
          severity: "warning",
        }),
      ],
    });
    expect(mocks.collectLegacyWhatsAppCrontabHealthWarning).toHaveBeenCalledTimes(1);
  });

  it("keeps channel plugin blockers opt-in for default lint selection", async () => {
    const blockerCheck = await requireDoctorHealthCheck("core/doctor/channel-plugin-blockers");
    expect(blockerCheck).toMatchObject({ defaultEnabled: false });
    mocks.scanConfiguredChannelPluginBlockers.mockReturnValue([
      { channelId: "discord", pluginId: "discord", reason: "missing explicit enablement" },
    ]);

    const ctx = createDoctorLintFixture({ channels: { discord: { enabled: true } } });
    const checks = [blockerCheck!];

    expect(mocks.scanConfiguredChannelPluginBlockers).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/channel-plugin-blockers"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-plugin-blockers",
          path: "channels.discord",
          target: "discord",
        }),
      ],
    });
    expect(mocks.scanConfiguredChannelPluginBlockers).toHaveBeenCalledWith(ctx.cfg, process.env);
  });

  it("defers channel package-state loading only until post-core plugin convergence", async () => {
    const contribution = requireDoctorContribution("doctor:channel-package-state-capabilities");
    mocks.collectBundledChannelPackageStateLoadFailures.mockReturnValue([
      {
        detail: "plugin module path not found: /plugins/example-chat/auth-presence",
        metadataKey: "persistedAuthState",
        pluginId: "example-chat",
      },
    ]);
    mocks.runDoctorHealthRepairs.mockImplementation(async (ctx, options) => {
      const findings = await options.checks[0]!.detect(ctx);
      return {
        config: ctx.cfg,
        findings,
        remainingFindings: findings,
        changes: [],
        warnings: [],
        diffs: [],
        effects: [],
        checksRun: 1,
        checksRepaired: 0,
        checksValidated: 0,
      };
    });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
    const ctx = createDoctorContext();

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).toHaveBeenCalledOnce();
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("core/doctor/channel-package-state-capabilities"),
    );
  });

  it("keeps channel preview warnings opt-in for default lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    expect(contribution.healthCheckIds).toEqual([
      "core/doctor/channel-plugin-blockers",
      "core/doctor/channel-preview-warnings",
    ]);
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toMatchObject({ defaultEnabled: false });
    mocks.collectChannelPreviewWarningHealthFindings.mockResolvedValue([
      {
        checkId: "core/doctor/channel-preview-warnings",
        severity: "warning",
        message: "channels.matrix has a preview warning",
        path: "channels.matrix",
      },
    ]);

    const ctx = createDoctorLintFixture({ channels: { matrix: { enabled: true } } });
    const checks = [previewWarningsCheck!];

    expect(mocks.collectChannelPreviewWarningHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/channel-preview-warnings"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-preview-warnings",
          path: "channels.matrix",
        }),
      ],
    });
    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: false,
    });
  });

  it("forwards allow-exec secret refs into channel preview warnings", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toBeDefined();
    const ctx = createDoctorLintFixture(
      { channels: { matrix: { enabled: true } } },
      { allowExecSecretRefs: true },
    );

    await previewWarningsCheck!.detect(ctx);

    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: true,
    });
  });
});
