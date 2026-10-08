import { runInitialConfigWriteHealth } from "./doctor-health-contribution-runners.config.js";
import {
  runClaudeCliHealth,
  runCommandOwnerHealth,
} from "./doctor-health-contribution-runners.gateway.js";
import {
  runChannelIngressDeadLettersHealth,
  runAgentMemorySchemaHealth,
  runCodexBwrapHealth,
  runCodexSessionRouteHealth,
  runConfigAuditScrubHealth,
  runDatabaseBloatHealth,
  runDiskSpaceHealth,
  runLegacyCronHealth,
  runLegacyPluginManifestHealth,
  runLegacyPluginSourceCapturesHealth,
  runPluginRegistryHealth,
  runReleaseConfiguredPluginInstallsHealth,
  runRetainedUpdateRuntimesHealth,
  runSandboxHealth,
  runSessionSnapshotsHealth,
  runSessionTranscriptHeadersHealth,
  runSessionTranscriptLabelsHealth,
  runSessionTranscriptsHealth,
  runStateIntegrityHealth,
} from "./doctor-health-contribution-runners.state.js";
import type {
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import type { HealthCheck, HealthRepairContext, HealthRepairEffect } from "./health-checks.js";

function legacyOwnedRepair(
  collectEffects: (ctx: HealthRepairContext) => Promise<readonly HealthRepairEffect[]>,
  reason: string,
): NonNullable<HealthCheck["repair"]> {
  return async (ctx) => {
    const effects = await collectEffects(ctx);
    return ctx.dryRun === true
      ? { status: "repaired", changes: [], effects }
      : { status: "skipped", reason, changes: [], effects };
  };
}

async function runStaleRuntimeBuildHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { runCoreContributionHealth } = await import("./doctor-health-contribution-core.js");
  await runCoreContributionHealth(ctx, ["core/doctor/stale-runtime-build"]);
}

async function runTelegramGeneralTopicConversationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { runCoreContributionHealth } = await import("./doctor-health-contribution-core.js");
  await runCoreContributionHealth(ctx, ["core/doctor/telegram-general-topic-conversations"]);
}

export function resolveInitialDoctorHealthContributions(params: {
  runStructuredHealthRepairs: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayConfigHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runAuthProfileMigration: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runAuthProfileHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayAuthHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runLegacyStateHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution("doctor:write-config-migrations", "Write config migrations", {
      required: true,
      run: runInitialConfigWriteHealth,
    }),
    createDoctorHealthContribution("doctor:agent-database-admission", "Agent database admission", {
      healthChecks: {
        description: "Agent databases with mismatched ownership are isolated until repaired.",
        async detect(ctx: DoctorHealthCheckContext) {
          const { evaluateAgentDatabaseAdmissions } =
            await import("../state/agent-database-admission.js");
          const refusals =
            ctx.agentDatabaseRefusals ??
            (await evaluateAgentDatabaseAdmissions(ctx.cfg, { env: ctx.env }));
          return refusals.map((refusal) => ({
            checkId: "core/doctor/agent-database-admission",
            severity: "warning" as const,
            target: refusal.agentId,
            requirement: refusal.code,
            message: `Agent ${refusal.agentId} is degraded. ${refusal.reason}`,
            fixHint: refusal.repairHint,
          }));
        },
      },
    }),
    createDoctorHealthContribution("doctor:node-runtime", "Node runtime", {
      healthCheckIds: ["core/doctor/node-runtime"],
      async run(ctx) {
        const { runCoreHealthFindingNote } = await import("./doctor-health-contribution-core.js");
        await runCoreHealthFindingNote(ctx, "core/doctor/node-runtime");
      },
    }),
    createDoctorHealthContribution("doctor:gateway-config", "Gateway config", {
      healthCheckIds: ["core/doctor/gateway-config"],
      run: params.runGatewayConfigHealth,
    }),
    createDoctorHealthContribution("doctor:auth-profile-migration", "Auth profile migration", {
      updateWork: { kind: "startup" },
      run: params.runAuthProfileMigration,
    }),
    createDoctorHealthContribution("doctor:auth-profiles", "Auth profiles", {
      updateWork: { kind: "inspection", scope: "agent", repairs: true },
      healthChecks: {
        description: "Auth profile cooldown, expiry, missing credential, and legacy override state",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectAuthProfileHealthFindings } = await import("../commands/doctor-auth.js");
          return collectAuthProfileHealthFindings({ cfg: ctx.cfg, allowKeychainPrompt: false });
        },
      },
      run: params.runAuthProfileHealth,
    }),
    createDoctorHealthContribution("doctor:claude-cli", "Claude CLI", {
      updateWork: { kind: "inspection", scope: "agent" },
      healthCheckIds: ["core/doctor/claude-cli"],
      run: runClaudeCliHealth,
    }),
    createDoctorHealthContribution("doctor:gateway-auth", "Gateway auth", {
      healthCheckIds: ["core/doctor/gateway-auth"],
      run: params.runGatewayAuthHealth,
    }),
    createDoctorHealthContribution(
      "doctor:node-hosting-preconditions",
      "Node hosting preconditions",
      {
        healthChecks: {
          description: "Gateway config can authenticate and onboard node and worker hosts.",
          async detect(ctx) {
            const { collectNodeHostingPreconditionFindings } =
              await import("../commands/doctor-node-hosting-preconditions.js");
            return collectNodeHostingPreconditionFindings(ctx.cfg);
          },
        },
      },
    ),
    createDoctorHealthContribution("doctor:command-owner", "Command owner", {
      updateWork: { kind: "inspection", scope: "run" },
      healthCheckIds: ["core/doctor/command-owner"],
      run: runCommandOwnerHealth,
    }),
    createDoctorHealthContribution(
      "doctor:structured-health-repairs",
      "Plugin health inspection and repair",
      {
        updateWork: { kind: "inspection", scope: "agent", repairs: true },
        run: params.runStructuredHealthRepairs,
      },
    ),
    createDoctorHealthContribution("doctor:legacy-state", "Legacy state", {
      healthCheckIds: ["core/doctor/legacy-state", "core/doctor/removed-workspaces-state"],
      run: params.runLegacyStateHealth,
    }),
    createDoctorHealthContribution("doctor:session-transcripts", "Session transcripts", {
      healthChecks: {
        description: "Legacy or branchy session transcript files are represented as findings.",
        defaultEnabled: false,
        async detect() {
          const { detectSessionTranscriptHealthIssues, sessionTranscriptIssueToHealthFinding } =
            await import("../commands/doctor-session-transcripts.js");
          return (await detectSessionTranscriptHealthIssues()).map(
            sessionTranscriptIssueToHealthFinding,
          );
        },
        repair: legacyOwnedRepair(async () => {
          const { detectSessionTranscriptHealthIssues, sessionTranscriptIssueToRepairEffect } =
            await import("../commands/doctor-session-transcripts.js");
          return (await detectSessionTranscriptHealthIssues()).map(
            sessionTranscriptIssueToRepairEffect,
          );
        }, "legacy doctor session transcript contribution owns transcript rewrites"),
      },
      run: runSessionTranscriptsHealth,
    }),
    createDoctorHealthContribution(
      "doctor:agent-memory-schema",
      "Agent memory schema",
      runAgentMemorySchemaHealth,
    ),
    createDoctorHealthContribution("doctor:legacy-plugin-manifests", "Legacy plugin manifests", {
      healthChecks: {
        description: "Legacy plugin manifest capability keys are reported as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const {
            collectLegacyPluginManifestContractMigrations,
            legacyPluginManifestContractMigrationToHealthFinding,
          } = await import("../commands/doctor-plugin-manifests.js");
          return collectLegacyPluginManifestContractMigrations({
            config: ctx.cfg,
            env: process.env,
          }).map(legacyPluginManifestContractMigrationToHealthFinding);
        },
      },
      run: runLegacyPluginManifestHealth,
    }),
    createDoctorHealthContribution(
      "doctor:legacy-plugin-dependencies",
      "Legacy plugin dependencies",
      {
        // Stable v2026.8.1 exposed this --only selector. Retain its public identity,
        // not the unsupported shared-root scan or its destructive repair advice.

        healthChecks: {
          description: "Deprecated shared plugin dependency cleanup check.",
          defaultEnabled: false,
          async detect() {
            return [
              {
                checkId: "core/doctor/legacy-plugin-dependencies",
                severity: "info",
                message:
                  "Deprecated check: Doctor preserves shared plugin runtime caches and no longer scans them for removal.",
              },
            ];
          },
        },
        run: async () => {},
      },
    ),
    createDoctorHealthContribution(
      "doctor:stale-plugin-runtime-symlinks",
      "Stale plugin runtime symlinks",
      {
        healthChecks: {
          description: "Stale plugin-runtime symlinks are represented as findings.",
          defaultEnabled: false,
          async detect() {
            const { collectStalePluginRuntimeSymlinkHealthFindings } =
              await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
            return collectStalePluginRuntimeSymlinkHealthFindings();
          },
        },
        run: async () => {},
      },
    ),
    createDoctorHealthContribution(
      "doctor:release-configured-plugin-installs",
      "Configured plugin repair",
      {
        healthChecks: {
          id: "core/doctor/configured-plugin-installs",
          description: "Configured plugin install records and package payloads are repairable.",
          defaultEnabled: false,
          async detect(ctx) {
            const {
              detectConfiguredPluginInstallHealthIssues,
              configuredPluginInstallIssueToHealthFinding,
            } = await import("../commands/doctor/shared/missing-configured-plugin-install.js");
            return (
              await detectConfiguredPluginInstallHealthIssues({ cfg: ctx.cfg, env: process.env })
            ).map(configuredPluginInstallIssueToHealthFinding);
          },
          repair: legacyOwnedRepair(async (ctx) => {
            const {
              detectConfiguredPluginInstallHealthIssues,
              configuredPluginInstallIssueToRepairEffect,
            } = await import("../commands/doctor/shared/missing-configured-plugin-install.js");
            return (
              await detectConfiguredPluginInstallHealthIssues({ cfg: ctx.cfg, env: process.env })
            ).map(configuredPluginInstallIssueToRepairEffect);
          }, "legacy doctor configured plugin install repair owns package mutation"),
        },
        run: runReleaseConfiguredPluginInstallsHealth,
      },
    ),
    createDoctorHealthContribution("doctor:plugin-registry", "Plugin registry", {
      healthChecks: {
        description: "Plugin registry migration, stale shadow, and peer-link issues are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectPluginRegistryHealthIssues, pluginRegistryIssueToHealthFinding } =
            await import("../commands/doctor-plugin-registry.js");
          return (
            await detectPluginRegistryHealthIssues({
              config: ctx.cfg,
              env: process.env,
              prompter: { shouldRepair: false },
            })
          ).map(pluginRegistryIssueToHealthFinding);
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const { detectPluginRegistryHealthIssues, pluginRegistryIssueToRepairEffect } =
            await import("../commands/doctor-plugin-registry.js");
          return (
            await detectPluginRegistryHealthIssues({
              config: ctx.cfg,
              env: process.env,
              prompter: { shouldRepair: false },
            })
          ).map(pluginRegistryIssueToRepairEffect);
        }, "legacy doctor plugin registry contribution owns registry repairs"),
      },
      run: runPluginRegistryHealth,
    }),
    createDoctorHealthContribution(
      "doctor:legacy-plugin-source-captures",
      "Legacy plugin captures",
      {
        updateWork: { kind: "startup" },
        run: runLegacyPluginSourceCapturesHealth,
      },
    ),
    createDoctorHealthContribution("doctor:retained-update-runtimes", "Updater runtimes", {
      updateWork: { kind: "startup" },
      run: runRetainedUpdateRuntimesHealth,
    }),
    createDoctorHealthContribution(
      "doctor:update-snapshots",
      "Retained update database snapshots",
      {
        updateWork: { kind: "standalone" },
        healthChecks: {
          description:
            "Retained npm update database snapshots need operator review before removal.",
          defaultEnabled: true,
          async detect(ctx) {
            const { collectUpdateSnapshotHealthFindings } =
              await import("../commands/doctor-update-snapshots.js");
            return collectUpdateSnapshotHealthFindings(ctx.env);
          },
        },
      },
    ),
    createDoctorHealthContribution("doctor:ui-protocol-freshness", "UI protocol freshness", {
      healthCheckIds: ["core/doctor/ui-protocol-freshness"],
      run: async () => {},
    }),
    createDoctorHealthContribution("doctor:stale-runtime-build", "Stale runtime build", {
      healthCheckIds: ["core/doctor/stale-runtime-build"],
      // healthCheckIds only claims the check for structured selection, which runs
      // under --lint/--fix; a plain `openclaw doctor` needs this runner to report.
      run: runStaleRuntimeBuildHealth,
    }),
    createDoctorHealthContribution("doctor:disk-space", "Disk space", {
      healthChecks: {
        description: "Low disk space around the OpenClaw state directory is a finding.",
        defaultEnabled: false,
        async detect() {
          const { collectDiskSpaceHealthFindings } =
            await import("../commands/doctor-disk-space.js");
          return collectDiskSpaceHealthFindings();
        },
      },
      run: runDiskSpaceHealth,
    }),
    createDoctorHealthContribution("doctor:project-clone-shape", "Project clones", {
      updateWork: { kind: "standalone" },
      healthChecks: {
        description: "Partial and shallow registry-owned project clones need manual repair.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectProjectCloneShapeHealthFindings } =
            await import("../commands/doctor-project-clone-shape.js");
          return await collectProjectCloneShapeHealthFindings(ctx.cfg);
        },
      },
      async run(ctx) {
        const { noteProjectCloneShape } = await import("../commands/doctor-project-clone-shape.js");
        await noteProjectCloneShape(ctx.cfg);
      },
    }),
    createDoctorHealthContribution("doctor:db-bloat", "SQLite database size", {
      updateWork: { kind: "standalone" },
      run: runDatabaseBloatHealth,
    }),
    createDoctorHealthContribution(
      "doctor:channel-ingress-dead-letters",
      "Channel ingress dead letters",
      {
        updateWork: { kind: "inspection", scope: "run" },
        run: runChannelIngressDeadLettersHealth,
      },
    ),
    createDoctorHealthContribution("doctor:state-integrity", "State integrity", {
      healthChecks: {
        description: "State directory, config permission, and runtime state issues are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectStateIntegrityHealthIssues, stateIntegrityIssueToHealthFinding } =
            await import("../commands/doctor-state-integrity.js");
          return detectStateIntegrityHealthIssues(ctx.cfg, {
            configPath: ctx.configPath,
            env: ctx.env ?? process.env,
          }).map(stateIntegrityIssueToHealthFinding);
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const { detectStateIntegrityHealthIssues, stateIntegrityIssueToRepairEffect } =
            await import("../commands/doctor-state-integrity.js");
          return detectStateIntegrityHealthIssues(ctx.cfg, {
            configPath: ctx.configPath,
            env: ctx.env ?? process.env,
          }).map(stateIntegrityIssueToRepairEffect);
        }, "legacy doctor state integrity contribution owns state repairs"),
      },
      run: runStateIntegrityHealth,
    }),
    createDoctorHealthContribution("doctor:codex-session-routes", "Codex session routes", {
      healthCheckIds: ["core/doctor/codex-session-routes"],
      run: runCodexSessionRouteHealth,
    }),
    createDoctorHealthContribution(
      "doctor:telegram-general-topic-conversations",
      "Telegram General-topic conversations",
      {
        healthCheckIds: ["core/doctor/telegram-general-topic-conversations"],
        run: runTelegramGeneralTopicConversationHealth,
      },
    ),
    createDoctorHealthContribution(
      "doctor:session-transcript-headers",
      "Session transcript headers",
      runSessionTranscriptHeadersHealth,
    ),
    createDoctorHealthContribution(
      "doctor:session-transcript-labels",
      "Session transcript labels",
      runSessionTranscriptLabelsHealth,
    ),
    createDoctorHealthContribution("doctor:session-snapshots", "Session snapshots", {
      updateWork: { kind: "inspection", scope: "agent" },
      healthChecks: {
        description:
          "Historical session snapshot paths are advisory findings; originals are preserved.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectSessionSnapshotHealthIssues, sessionSnapshotIssueToHealthFinding } =
            await import("../commands/doctor-session-snapshots.js");
          return (await detectSessionSnapshotHealthIssues({ cfg: ctx.cfg, env: process.env })).map(
            sessionSnapshotIssueToHealthFinding,
          );
        },
      },
      run: runSessionSnapshotsHealth,
    }),
    createDoctorHealthContribution("doctor:config-audit-scrub", "Config audit", {
      healthChecks: {
        description:
          "Historical config-audit argv redaction gaps are represented as structured findings.",
        defaultEnabled: false,
        async detect() {
          const { configAuditScrubToHealthFinding, detectConfigAuditScrubIssue } =
            await import("../commands/doctor-config-audit-scrub.js");
          const result = await detectConfigAuditScrubIssue();
          return result.rewritten > 0 ? [configAuditScrubToHealthFinding(result)] : [];
        },
        repair: legacyOwnedRepair(async () => {
          const { configAuditScrubToRepairEffect, detectConfigAuditScrubIssue } =
            await import("../commands/doctor-config-audit-scrub.js");
          const result = await detectConfigAuditScrubIssue();
          return result.rewritten > 0 ? [configAuditScrubToRepairEffect(result)] : [];
        }, "legacy doctor config audit contribution owns cleanup"),
      },
      run: runConfigAuditScrubHealth,
    }),
    createDoctorHealthContribution("doctor:legacy-cron", "Legacy cron", {
      healthCheckIds: ["core/doctor/legacy-whatsapp-crontab", "core/doctor/legacy-cron-store"],
      run: runLegacyCronHealth,
    }),
    createDoctorHealthContribution("doctor:sandbox", "Sandbox", {
      healthChecks: {
        id: "core/doctor/sandbox/registry-files",
        description: "Legacy sandbox registry files are represented in SQLite registry storage.",
        async detect() {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToHealthFinding,
          } = await import("../commands/doctor-sandbox.js");
          return (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToHealthFinding,
          );
        },
        repair: legacyOwnedRepair(async () => {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToRepairEffect,
          } = await import("../commands/doctor-sandbox.js");
          return (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToRepairEffect,
          );
        }, "legacy doctor sandbox contribution owns registry migration"),
      },
      run: runSandboxHealth,
    }),
    createDoctorHealthContribution("doctor:codex-bwrap", "Codex bwrap sandbox", {
      updateWork: { kind: "standalone" },
      run: runCodexBwrapHealth,
    }),
  ];
}
