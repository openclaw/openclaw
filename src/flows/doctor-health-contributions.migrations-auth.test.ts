import { describe, expect, it, vi } from "vitest";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  setupDoctorHealthContributionsFixture,
  mocks,
  requireDoctorContribution,
  requireDoctorHealthCheck,
  createDoctorContext,
  createDoctorLintFixture,
  withProcessPlatform,
} from "./doctor-health-contributions-suite.test-support.js";
import { resolveDoctorContributionHealthChecks } from "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./doctor-health-contributions-suite.test-support.js"));

describe("doctor health contributions", () => {
  setupDoctorHealthContributionsFixture();

  it("hints how to enable authenticated GitHub project search", async () => {
    const contribution = requireDoctorContribution("doctor:github-projects");
    const ctx = createDoctorContext({
      cfg: {},
      configResult: {},
      env: {},
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.github.host matching gateway.github.host"),
      "GitHub projects",
    );

    mocks.note.mockClear();
    await contribution.run({ ...ctx, env: { GH_TOKEN: "configured" } });
    expect(mocks.note).not.toHaveBeenCalled();

    await contribution.run({
      ...ctx,
      cfg: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" },
            },
          },
        },
      },
    });
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("grants Doctor-only state migration authority only in repair mode", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    const cfg = { session: { store: "/tmp/shared-sessions.json" } };
    const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    const ctx = createDoctorContext({
      cfg,
      configResult: {},
      shouldRepair: true,
      options: { nonInteractive: true, repair: true },
      configPath: "/tmp/openclaw.json",
    });

    await contribution.run(ctx);

    const detectParams = mocks.detectLegacyStateMigrations.mock.calls[0]?.[0] as
      | {
          legacySessionSurfaces?: unknown;
        }
      | undefined;
    const legacySessionSurfaces = detectParams?.legacySessionSurfaces;
    expect(legacySessionSurfaces).toMatchObject({ failures: [], surfaces: expect.any(Array) });
    expect(mocks.detectLegacyStateMigrations).toHaveBeenCalledWith({
      cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
    expect(mocks.runLegacyStateMigrations).toHaveBeenCalledWith({
      detected,
      config: cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
  });

  it("renews exec approvals when an unrelated legacy migration is declined", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-state");
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: ["legacy sessions"],
      warnings: [],
      notices: [],
    });
    mocks.repairObsoleteGeneratedExecApprovals.mockReturnValue(1);
    const ctx = createDoctorContext({
      shouldRepair: true,
      options: { repair: true },
      prompter: createDoctorPrompterFixture(false),
    });

    await contribution.run(ctx);

    expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();
    expect(mocks.repairObsoleteGeneratedExecApprovals).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("removed 1 older generated approval"),
      "Doctor changes",
    );
  });

  it.each(["deferred", "refused"] as const)(
    "prints legacy state migration notices and records only advisories (%s)",
    async (outcome) => {
      const contribution = requireDoctorContribution("doctor:legacy-state");
      const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
      mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
      mocks.runLegacyStateMigrations.mockResolvedValue({
        changes: [],
        warnings: [],
        notices: ["Left reviewed legacy residue in place."],
        stepReceipts: [
          {
            id: "legacy-cleanup",
            phase: "final",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "checkpoint-required",
            outcome,
            changes: [],
            warnings: ["Legacy cleanup deferred; run openclaw doctor --fix"],
          },
        ],
      });
      const ctx = createDoctorContext({
        cfg: {},
        configResult: {},
        shouldRepair: true,
        options: { nonInteractive: true },
        configPath: "/tmp/openclaw.json",
      });

      await contribution.run(ctx);

      expect(mocks.note).toHaveBeenCalledWith(
        "Left reviewed legacy residue in place.",
        "Doctor notices",
      );
      expect(ctx.updateWarnings ?? []).toEqual(
        outcome !== "refused" ? ["Legacy cleanup deferred; run openclaw doctor --fix"] : [],
      );
    },
  );

  it("cleans retired auth profiles before reporting profile health", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" as const },
        },
      },
    };
    const repairedCfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: repairedCfg,
      retiredProfileCleanupPlans: [
        {
          agentDir: "/tmp/openclaw/agents/main",
          profileIds: ["anthropic:claude-cli"],
        },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      sourceConfigValid: true,
      prompter: createDoctorPrompterFixture(true),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { nonInteractive: true },
    });

    await requireDoctorContribution("doctor:auth-profile-migration").run(ctx);
    await contribution.run(ctx);

    expect(mocks.maybeRepairLegacyOAuthProfileIds).toHaveBeenCalledBefore(
      mocks.maybeMigrateModelCatalogCredentials,
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: repairedCfg }),
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/main",
        profileIds: ["anthropic:claude-cli"],
      }),
    );
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.noteAuthProfileHealth.mock.invocationCallOrder[0]!,
    );
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toBeUndefined();
    expect(ctx.configResult.explicitSetPaths).toContainEqual(["agents", "defaults", "models"]);
  });

  it("does not clean or report retired profiles when an update handoff skips persistence", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {};
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      retiredProfileCleanupPlans: [
        {
          agentDir: "/tmp/openclaw/agents/main",
          profileIds: ["anthropic:claude-cli"],
        },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: cfg,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      prompter: createDoctorPrompterFixture(true),
    });

    await requireDoctorContribution("doctor:auth-profile-migration").run(ctx);
    await contribution.run(ctx);

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    expect(mocks.noteAuthProfileHealth).not.toHaveBeenCalled();
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toHaveLength(1);
  });

  it("registers auth profile health as an opt-in structured check", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const [check] = contribution.healthChecks;

    expect(contribution.healthCheckIds).toEqual(["core/doctor/auth-profiles"]);
    expect(check).toMatchObject({
      id: "core/doctor/auth-profiles",
      kind: "core",
      defaultEnabled: false,
    });
    if (!check || !("detect" in check)) {
      throw new Error("expected split auth profile health check");
    }

    await check.detect(createDoctorLintFixture({ auth: { profiles: {} } }));

    expect(mocks.collectAuthProfileHealthFindings).toHaveBeenCalledWith({
      cfg: { auth: { profiles: {} } },
      allowKeychainPrompt: false,
    });
  });

  it("forwards skipped Gateway health to daemon repair", async () => {
    const contribution = requireDoctorContribution("doctor:gateway-daemon");
    const ctx = createDoctorContext({
      cfg: {},
      gatewayDetails: { message: "gateway details" },
      gatewayHealthSkipped: true,
      healthOk: false,
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    } as unknown as Parameters<typeof createDoctorContext>[0]);

    await contribution.run(ctx);

    expect(mocks.maybeRepairGatewayDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        prompter: ctx.prompter,
        options: ctx.options,
        gatewayDetailsMessage: "gateway details",
        healthOk: false,
        healthSkipped: true,
      }),
    );
  });

  it("preserves interactive linger repair for a user-scoped Gateway service", async () => {
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local" } },
    });

    await withProcessPlatform("linux", async () => {
      await contribution.run(ctx);
    });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledOnce();
  });

  it("keeps selected systemd linger quiet when the gateway service is not loaded", async () => {
    mocks.gatewayServiceIsLoaded.mockResolvedValue(false);
    const systemdLingerCheck = await requireDoctorHealthCheck("core/doctor/systemd-linger");

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [systemdLingerCheck!],
          onlyIds: ["core/doctor/systemd-linger"],
        }),
      ).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [],
      });
    });
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it("skips user lingering for a reachable system-scoped Gateway service in a container", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const checks = await resolveDoctorContributionHealthChecks();
    const lingerCheck = checks.find((check) => check.id === "core/doctor/systemd-linger");
    expect(lingerCheck).toBeDefined();
    const lintResult = await withProcessPlatform("linux", async () => {
      await contribution.run(
        createDoctorContext({
          cfg: { gateway: { mode: "local" } },
        }),
      );
      return await runDoctorLintChecks(createDoctorLintFixture({ gateway: { mode: "local" } }), {
        checks: [lingerCheck!],
        onlyIds: ["core/doctor/systemd-linger"],
      });
    });

    expect(mocks.findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(2);
    expect(mocks.gatewayServiceIsLoaded).not.toHaveBeenCalled();
    expect(mocks.isSystemdUserServiceAvailable).not.toHaveBeenCalled();
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
    expect(lintResult).toMatchObject({ checksRun: 1, findings: [] });
    expect(JSON.stringify(lintResult)).not.toContain("loginctl enable-linger");
  });

  it("reports the Gateway service owner under sudo-to-root", async () => {
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus.mockImplementation(async (params) =>
      params?.user === "debian" ? { user: "debian", linger: "no" } : null,
    );
    const systemdLingerCheck = await requireDoctorHealthCheck("core/doctor/systemd-linger");
    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [systemdLingerCheck!],
          onlyIds: ["core/doctor/systemd-linger"],
        }),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            fixHint: "Run: sudo loginctl enable-linger debian",
            target: "systemd.user.debian",
          }),
        ],
      });
    });
  });

  describe("Doctor contribution migration outcomes", () => {
    function receipt(
      outcome: "refused" | "warning",
      requiredness: "required" | "conditional",
    ): LegacyStateMigrationStepReceipt {
      return {
        id: "plugin-doctor-post-session-state",
        phase: "final",
        source: [{ kind: "owner", id: "plugin:example:legacy-state" }],
        target: [{ kind: "owner", id: "plugin:example:doctor-state" }],
        requiredness,
        reversibility: "checkpoint-required",
        outcome,
        changes: [],
        warnings: ["Owner could not complete the planned repair"],
        ...(outcome === "refused"
          ? {
              refusal: {
                code: "step-refused",
                message: "Owner could not complete the planned repair",
              },
            }
          : {}),
      };
    }

    it("stops copied-state rehearsal after a conditional migration refusal", async () => {
      const recorded = receipt("refused", "conditional");
      const receipts: LegacyStateMigrationStepReceipt[] = [];
      const ctx = createDoctorHealthFlowContext({
        configResult: { stateMigrationStepReceipts: receipts },

        env: {
          ...buildUpdateRehearsalPathEnv("/synthetic/rehearsal"),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
        },
        updateBudget: {
          agentCount: 1,
          phase: "validation" as const,
          inspectionDeadlineMs: Date.now() + 149_000,
          source: "validation-ledger" as const,
          deferred: new Map(),
        },
      });
      const later = vi.fn(async () => {});
      await expect(
        runDoctorHealthContributionList(ctx, [
          createDoctorHealthContribution("doctor:session-transcripts", "Sessions", {
            run: async () => {
              receipts.push(recorded);
            },
          }),
          createDoctorHealthContribution("doctor:later", "Later repair", later),
        ]),
      ).rejects.toMatchObject({ stepReceipts: [recorded] });
      expect(later).not.toHaveBeenCalled();
      expect(receipts).toEqual([recorded]);
    });

    it("continues after an owner-classified recoverable warning and an unrelated advisory throw", async () => {
      const recorded = receipt("warning", "conditional");
      const receipts: LegacyStateMigrationStepReceipt[] = [];
      const ctx = createDoctorHealthFlowContext({
        configResult: { stateMigrationStepReceipts: receipts },
      });
      const later = vi.fn(async () => {});
      await runDoctorHealthContributionList(ctx, [
        createDoctorHealthContribution("doctor:session-transcripts", "Sessions", {
          run: async () => {
            receipts.push(recorded);
          },
        }),
        createDoctorHealthContribution("doctor:advisory", "Advisory", {
          run: async () => {
            throw new Error("optional diagnostic\nunavailable");
          },
        }),
        createDoctorHealthContribution("doctor:later", "Later repair", later),
      ]);
      expect(later).toHaveBeenCalledOnce();
      expect(receipts).toEqual([recorded]);
      expect(mocks.note).toHaveBeenCalledWith(
        "doctor:advisory run failed: optional diagnostic unavailable",
        "Doctor warnings",
      );
    });
  });
});
