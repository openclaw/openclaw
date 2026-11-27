import { note } from "../../packages/terminal-core/src/note.js";
import { noteBackupDoctorHint } from "../commands/backup-health.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  checkGatewayAuthRepairPending,
  runGatewayAuthHealth,
} from "./doctor-gateway-auth-repair.js";
import { gmailGogCheck } from "./doctor-gmail-gog-check.js";
import { checkInitialConfigWriteHealthPending } from "./doctor-health-contribution-runners.config-plan.js";
import { runInitialConfigWriteHealth } from "./doctor-health-contribution-runners.config.js";
import {
  runClaudeCliHealth,
  runCommandOwnerHealth,
} from "./doctor-health-contribution-runners.gateway.js";
import {
  checkAgentMemorySchemaPending,
  checkLegacyPluginManifestPending,
  checkConfiguredPluginInstallReleasePending,
  checkLegacyPluginSourceCapturesContributionPending,
  checkLegacyRuntimeFilesContributionPending,
  checkLegacyStatePending,
  checkPluginRegistryContributionPending,
  checkSessionTranscriptHeadersContributionPending,
  checkSessionTranscriptLabelsContributionPending,
  checkTelegramGeneralTopicConversationsPending,
  runAgentMemorySchemaHealth,
  runCodexSessionRouteHealth,
  runConfiguredPluginInstallReleaseHealth,
  runLegacyCronHealth,
  runLegacyPluginManifestHealth,
  runSessionTranscriptHeadersHealth,
  runSessionTranscriptLabelsHealth,
  runSessionTranscriptsHealth,
} from "./doctor-health-contribution-runners.state.js";
import { checkSandboxContributionPending } from "./doctor-health-contribution-runners.workspace.js";
import type {
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceDir } from "./doctor-health-contribution-utils.js";
import {
  coreHealthContribution,
  createDoctorHealthContribution,
  legacyOwnedRepair,
  recordDoctorHealthWarnings,
} from "./doctor-health-contribution.js";
import { memberRolesCheck, runMemberRolesHealth } from "./doctor-member-roles.js";
import { appContainerSpawnCheck, nativeStatusCheck } from "./doctor-native-status-check.js";
import { openClawIdAccessCheck, runOpenClawIdAccessHealth } from "./doctor-openclaw-id-access.js";

/** Under Gateway maintenance, Doctor removes abandoned runtimes before it stops the Gateway. */
function retainedUpdateRuntimesCleanedBeforeStop(ctx: DoctorHealthFlowContext): boolean {
  return ctx.gatewayMaintenanceActive === true && ctx.prompter.shouldRepair;
}

export function resolveInitialDoctorHealthContributions(params: {
  runStructuredHealthRepairs: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayConfigHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runAuthProfileMigration: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runAuthProfileHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runLegacyStateHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution("doctor:write-config-migrations", "Write config migrations", {
      required: true,
      pending: checkInitialConfigWriteHealthPending,
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
    createDoctorHealthContribution("doctor:native-status", "Native helpers and child pipes", {
      healthChecks: [appContainerSpawnCheck, nativeStatusCheck],
    }),
    createDoctorHealthContribution("doctor:node-runtime", "Node runtime", {
      pending: "diagnostic-only",
      healthCheckIds: ["core/doctor/node-runtime"],
      async run(ctx) {
        const { runCoreHealthFindingNote } = await import("./doctor-health-contribution-core.js");
        await runCoreHealthFindingNote(ctx, "core/doctor/node-runtime");
      },
    }),
    createDoctorHealthContribution("doctor:runtime-capabilities", "Runtime capabilities", {
      pending: "diagnostic-only",
      healthCheckIds: ["core/doctor/runtime-capabilities"],
      async run() {
        const { collectRuntimeCapabilities, formatRuntimeCapabilities } =
          await import("../infra/runtime-capabilities.js");
        note(
          formatRuntimeCapabilities(collectRuntimeCapabilities()),
          "Runtime capabilities (Doctor process)",
        );
      },
    }),
    createDoctorHealthContribution("doctor:gateway-config", "Gateway config", {
      pending: "diagnostic-only",
      healthCheckIds: ["core/doctor/gateway-config"],
      run: params.runGatewayConfigHealth,
    }),
    createDoctorHealthContribution("doctor:database-engine", "Database engines", {
      pending: "diagnostic-only",
      updateWork: { kind: "inspection", scope: "agent" },
      healthChecks: {
        description: "Selected database engines, physical store health, and recovery guidance.",
        async detect(ctx) {
          const { collectDoctorDatabaseEngineHealthFindings } =
            await import("../commands/doctor-database-engine.js");
          return collectDoctorDatabaseEngineHealthFindings(ctx.cfg, { env: ctx.env });
        },
      },
      async run(ctx) {
        const { noteDatabaseEngines } = await import("../commands/doctor-database-engine.js");
        recordDoctorHealthWarnings(ctx, await noteDatabaseEngines(ctx.cfg, { env: ctx.env }));
      },
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
      async pending(ctx) {
        const { checkAuthProfileRefreshPending } = await import("../commands/doctor-auth.js");
        return checkAuthProfileRefreshPending({
          cfg: ctx.cfg,
          env: ctx.env,
          inspectProfiles: ctx.authProfileHealthReady !== false,
        });
      },
      run: params.runAuthProfileHealth,
    }),
    createDoctorHealthContribution("doctor:claude-cli", "Claude CLI", {
      pending: "diagnostic-only",
      updateWork: { kind: "inspection", scope: "agent" },
      healthCheckIds: ["core/doctor/claude-cli"],
      run: runClaudeCliHealth,
    }),
    createDoctorHealthContribution("doctor:gmail-gog", "Gmail Gog", {
      updateWork: { kind: "inspection", scope: "run" },
      healthChecks: gmailGogCheck,
    }),
    createDoctorHealthContribution("doctor:gateway-auth", "Gateway auth", {
      healthCheckIds: ["core/doctor/gateway-auth"],
      pending: checkGatewayAuthRepairPending,
      run: runGatewayAuthHealth,
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
            const findings = await collectNodeHostingPreconditionFindings(ctx.cfg);
            // The rehearsal's loopback listener does not describe the serving Gateway's ingress.
            return resolveUpdateRehearsalRoot(ctx.env ?? process.env)
              ? findings.filter((finding) => finding.requirement !== "node-onboarding-url")
              : findings;
          },
        },
      },
    ),
    createDoctorHealthContribution("doctor:command-owner", "Command owner", {
      pending: "diagnostic-only",
      updateWork: { kind: "inspection", scope: "run" },
      healthCheckIds: ["core/doctor/command-owner"],
      run: runCommandOwnerHealth,
    }),
    createDoctorHealthContribution(
      "doctor:structured-health-repairs",
      "Plugin health inspection and repair",
      {
        updateWork: { kind: "inspection", scope: "agent", repairs: true },
        async pending(ctx) {
          const { checkStructuredHealthRepairsContributionPending } =
            await import("./doctor-health-contribution-core.js");
          return checkStructuredHealthRepairsContributionPending(ctx);
        },
        run: params.runStructuredHealthRepairs,
      },
    ),
    createDoctorHealthContribution("doctor:legacy-state", "Legacy state", {
      healthCheckIds: [
        "core/doctor/legacy-state",
        "core/doctor/removed-workspaces-state",
        "core/doctor/session-archive-read-cache",
      ],
      pending: checkLegacyStatePending,
      run: params.runLegacyStateHealth,
    }),
    createDoctorHealthContribution("doctor:session-transcripts", "Chat history", {
      healthChecks: {
        description: "Legacy or branched chat history files are represented as findings.",
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
    createDoctorHealthContribution("doctor:agent-memory-schema", "Agent memory schema", {
      pending: checkAgentMemorySchemaPending,
      run: runAgentMemorySchemaHealth,
    }),
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
      pending: checkLegacyPluginManifestPending,
      run: runLegacyPluginManifestHealth,
    }),
    createDoctorHealthContribution(
      "doctor:legacy-plugin-dependencies",
      "Legacy plugin dependencies",
      {
        pending: "diagnostic-only",
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
        pending: "diagnostic-only",
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
        pending: checkConfiguredPluginInstallReleasePending,
        run: runConfiguredPluginInstallReleaseHealth,
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
      pending: checkPluginRegistryContributionPending,
      async run(ctx) {
        const { maybeRepairPluginRegistryState } =
          await import("../commands/doctor-plugin-registry.js");
        const result = await maybeRepairPluginRegistryState({
          config: ctx.cfg,
          env: process.env,
          prompter: ctx.prompter,
        });
        ctx.cfg = result.config;
        if (result.pluginInventoryChanged) {
          ctx.invalidatePluginMetadataSnapshot?.();
        }
      },
    }),
    createDoctorHealthContribution(
      "doctor:legacy-plugin-source-captures",
      "Legacy plugin captures",
      {
        updateWork: { kind: "startup" },
        pending: checkLegacyPluginSourceCapturesContributionPending,
        async run(ctx) {
          const { noteLegacyPluginSourceCaptures } =
            await import("../commands/doctor-plugin-source-captures.js");
          await noteLegacyPluginSourceCaptures(ctx.env ?? process.env, ctx.prompter.shouldRepair);
        },
      },
    ),
    createDoctorHealthContribution("doctor:retained-update-runtimes", "Updater runtimes", {
      updateWork: { kind: "startup" },
      // Without repair the pass only reports.
      pending: (ctx) =>
        retainedUpdateRuntimesCleanedBeforeStop(ctx) || !ctx.prompter.shouldRepair
          ? "none"
          : "work",
      async run(ctx) {
        if (retainedUpdateRuntimesCleanedBeforeStop(ctx)) {
          return;
        }
        const { prepareRetainedUpdateRuntimeCleanup } =
          await import("../commands/doctor-retained-runtime.js");
        const cleanup = await prepareRetainedUpdateRuntimeCleanup(ctx.env ?? process.env);
        await cleanup(ctx.prompter.shouldRepair);
      },
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
      pending: "diagnostic-only",
      healthCheckIds: ["core/doctor/ui-protocol-freshness"],
      run: async () => {},
    }),
    createDoctorHealthContribution("doctor:stale-runtime-build", "Stale runtime build", {
      healthCheckIds: ["core/doctor/stale-runtime-build"],
      // healthCheckIds only claims the check for structured selection, which runs
      // under --lint/--fix; a plain `openclaw doctor` needs this runner to report.
      ...coreHealthContribution("core/doctor/stale-runtime-build"),
    }),
    createDoctorHealthContribution("doctor:disk-space", "Disk space", {
      pending: "diagnostic-only",
      healthChecks: {
        description: "Low disk space around the OpenClaw state directory is a finding.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectDiskSpaceHealthFindings } =
            await import("../commands/doctor-disk-space.js");
          return collectDiskSpaceHealthFindings(ctx.env);
        },
      },
      async run() {
        const { noteDiskSpace } = await import("../commands/doctor-disk-space.js");
        noteDiskSpace();
      },
    }),
    createDoctorHealthContribution("doctor:project-clone-shape", "Project clones", {
      updateWork: { kind: "standalone" },
      healthChecks: {
        description: "Shallow registry-owned project clones need full history.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectProjectCloneShapeHealthFindings } =
            await import("../commands/doctor-project-clone-shape.js");
          return await collectProjectCloneShapeHealthFindings(ctx.cfg, { env: ctx.env });
        },
      },
      async pending(ctx) {
        const { checkProjectCloneShapePending } =
          await import("../commands/doctor-project-clone-shape.js");
        return checkProjectCloneShapePending(ctx.cfg, { repair: ctx.options.repair, env: ctx.env });
      },
      async run(ctx) {
        const { noteProjectCloneShape } = await import("../commands/doctor-project-clone-shape.js");
        await noteProjectCloneShape(ctx.cfg, { repair: ctx.options.repair, env: ctx.env });
      },
    }),
    createDoctorHealthContribution("doctor:db-bloat", "SQLite database size", {
      pending: "diagnostic-only",
      updateWork: { kind: "standalone" },
      async run() {
        const { noteSqliteDatabaseBloat } = await import("../commands/doctor-db-bloat.js");
        await noteSqliteDatabaseBloat();
      },
    }),
    createDoctorHealthContribution(
      "doctor:channel-ingress-dead-letters",
      "Channel ingress dead letters",
      {
        pending: "diagnostic-only",
        updateWork: { kind: "inspection", scope: "run" },
        async run() {
          const { noteChannelIngressDeadLetters } =
            await import("../commands/doctor-channel-ingress.js");
          await noteChannelIngressDeadLetters();
        },
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
      async run(ctx) {
        const { noteDoctorAgentDatabasePathHealth } =
          await import("../commands/doctor-agent-database-paths.js");
        const warnings = noteDoctorAgentDatabasePathHealth({
          env: ctx.env ?? process.env,
          shouldRepair: ctx.prompter.shouldRepair,
        });
        if (warnings.length > 0) {
          ctx.updateWarnings ??= [];
          ctx.updateWarnings.push(...warnings);
        }
        const { noteStateIntegrity } = await import("../commands/doctor-state-integrity.js");
        await noteStateIntegrity(ctx.cfg, ctx.prompter, ctx.configPath, {
          stateDirExistedAtStart: ctx.stateDirExistedAtStart,
        });
        await noteBackupDoctorHint(ctx.env ?? process.env, ctx.cfg);
        const { noteBackupScratchHealth } = await import("../commands/doctor-backup-scratch.js");
        await noteBackupScratchHealth(ctx.env ?? process.env, ctx.prompter.shouldRepair);
      },
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
        ...coreHealthContribution("core/doctor/telegram-general-topic-conversations"),
        pending: checkTelegramGeneralTopicConversationsPending,
      },
    ),
    createDoctorHealthContribution("doctor:session-transcript-headers", "Chat history headers", {
      pending: checkSessionTranscriptHeadersContributionPending,
      run: runSessionTranscriptHeadersHealth,
    }),
    createDoctorHealthContribution("doctor:session-transcript-labels", "Chat history labels", {
      pending: checkSessionTranscriptLabelsContributionPending,
      run: runSessionTranscriptLabelsHealth,
    }),
    createDoctorHealthContribution("doctor:session-snapshots", "Session snapshots", {
      pending: "diagnostic-only",
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
      async run(ctx) {
        const { noteSessionSnapshotHealth } =
          await import("../commands/doctor-session-snapshots.js");
        await noteSessionSnapshotHealth({
          cfg: ctx.cfg,
          env: ctx.env ?? process.env,
        });
      },
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
      pending: checkLegacyRuntimeFilesContributionPending,
      async run(ctx) {
        const { maybeRepairLegacyRuntimeFiles } =
          await import("../commands/doctor-usage-cost-cache.js");
        const warnings = await maybeRepairLegacyRuntimeFiles(ctx.prompter.shouldRepair, ctx.env);
        recordDoctorHealthWarnings(ctx, [], warnings);
      },
    }),
    createDoctorHealthContribution("doctor:legacy-cron", "Legacy cron", {
      healthCheckIds: [
        "core/doctor/legacy-whatsapp-crontab",
        "core/doctor/legacy-cron-store",
        "core/doctor/cron-inference-accounts",
      ],
      run: runLegacyCronHealth,
    }),
    createDoctorHealthContribution("doctor:sandbox", "Sandbox", {
      healthChecks: [
        {
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
        memberRolesCheck,
        openClawIdAccessCheck,
      ],
      pending: checkSandboxContributionPending,
      async run(ctx) {
        await runOpenClawIdAccessHealth(ctx);
        await runMemberRolesHealth(ctx);
        const {
          maybeRepairSandboxImages,
          maybeRepairSandboxRegistryFiles,
          noteSandboxScopeWarnings,
        } = await import("../commands/doctor-sandbox.js");
        const maintenance = getOpenClawDatabaseMaintenanceScope();
        await maybeRepairSandboxRegistryFiles(ctx.prompter, () => {
          if (!maintenance) {
            throw new Error(
              "Retired sandbox registry repair requires exclusive maintenance ownership",
            );
          }
          maintenance.assertOwnerCurrent();
        });
        const imageWarnings = await maybeRepairSandboxImages(ctx.cfg, ctx.runtime, ctx.prompter);
        recordDoctorHealthWarnings(ctx, [], imageWarnings);
        noteSandboxScopeWarnings(ctx.cfg);
      },
    }),
    createDoctorHealthContribution("doctor:codex-bwrap", "Codex bwrap sandbox", {
      pending: "diagnostic-only",
      updateWork: { kind: "standalone" },
      async run(ctx) {
        const { noteCodexBwrapNamespaceWarnings } = await import("../commands/doctor-sandbox.js");
        await noteCodexBwrapNamespaceWarnings(ctx.cfg, {
          env: ctx.env,
          cwd: resolveDoctorWorkspaceDir(ctx.cfg, ctx.env),
        });
      },
    }),
  ];
}
