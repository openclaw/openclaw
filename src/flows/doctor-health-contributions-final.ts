import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { shouldDeferConfiguredPluginInstallRepair } from "../commands/doctor/shared/update-phase.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import { runCoreHealthFindingNote } from "./doctor-health-contribution-core.js";
import {
  collectWriteConfigHealthFindings,
  runFinalConfigValidationHealth,
  runWriteConfigHealth,
} from "./doctor-health-contribution-runners.config.js";
import {
  runBrowserHealth,
  runDevicePairingHealth,
  runGatewayDaemonHealth,
  runGatewayServicesHealth,
  runHostDesktopHealth,
  runGitHubProjectHealth,
  runOpenAIOAuthTlsHealth,
  runSecurityHealth,
  runStartupChannelMaintenanceHealth,
  runWebFetchProxyHealth,
  runWhatsappResponsivenessHealth,
} from "./doctor-health-contribution-runners.gateway.js";
import {
  collectWorkspaceStatusPluginVersionReadiness,
  runBootstrapSizeHealth,
  runHeartbeatCadenceMigrationHealth,
  runHeartbeatScratchMigrationHealth,
  runHeartbeatTaskMigrationHealth,
  runHooksModelHealth,
  runMemorySearchHealthContribution,
  runSkillsHealth,
  runToolsMdMigrationHealth,
  runWorkspaceAliasHealth,
  runWorkspaceStatusHealth,
  runWorkspaceSuggestionsHealth,
} from "./doctor-health-contribution-runners.workspace.js";
import type {
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import type { HealthCheck } from "./health-checks.js";

const CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID =
  "core/doctor/channel-package-state-capabilities";

export function resolveFinalDoctorHealthContributions(params: {
  runSystemdLingerHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  detectSystemdLingerFindings: HealthCheck["detect"];
  runShellCompletionHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayHealthChecks: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution("doctor:gateway-services", "Gateway services", {
      healthCheckIds: [
        "core/doctor/gateway-services/extra",
        "core/doctor/gateway-services/platform-notes",
      ],
      run: runGatewayServicesHealth,
    }),
    createDoctorHealthContribution("doctor:host-desktop", "Host desktop", {
      healthChecks: {
        description: "Gateway-host desktop enablement, reachability, and RFB security state.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectHostDesktopHealthFindings } =
            await import("../commands/doctor-host-desktop.js");
          return collectHostDesktopHealthFindings(ctx.cfg);
        },
      },
      run: runHostDesktopHealth,
    }),
    createDoctorHealthContribution("doctor:default-account-routing", "Default account routing", {
      updateWork: { kind: "inspection", scope: "run" },
      healthChecks: {
        description: "Multi-account channels have explicit default routing or complete bindings.",
        defaultEnabled: false,
        async detect(ctx) {
          const {
            collectMissingDefaultAccountBindingWarnings,
            collectMissingExplicitDefaultAccountWarnings,
          } = await import("../commands/doctor/shared/default-account-warnings.js");
          return [
            ...collectMissingDefaultAccountBindingWarnings(ctx.cfg),
            ...collectMissingExplicitDefaultAccountWarnings(ctx.cfg),
          ].map((message) => ({
            checkId: "core/doctor/default-account-routing",
            severity: "warning" as const,
            message: message.replace(/^- /, "").trim(),
          }));
        },
      },
    }),
    createDoctorHealthContribution(
      "doctor:channel-package-state-capabilities",
      "Channel package-state capabilities",
      {
        healthChecks: {
          id: CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID,
          description: "Declared channel package-state checker modules must load.",
          defaultEnabled: true,
          async detect(ctx) {
            if (shouldDeferConfiguredPluginInstallRepair(ctx.env ?? process.env)) {
              return [];
            }
            const { collectBundledChannelPackageStateLoadFailures } =
              await import("../channels/plugins/package-state-probes.js");
            return collectBundledChannelPackageStateLoadFailures().map((failure) => ({
              checkId: CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID,
              severity: "warning" as const,
              message: `Plugin ${failure.pluginId} declared ${failure.metadataKey}, but its checker failed to load: ${failure.detail}`,
              target: failure.pluginId,
              requirement: "declared-channel-package-state-capability-loadable",
              fixHint: `Rebuild or reinstall plugin ${failure.pluginId}, then rerun \`openclaw doctor\`.`,
            }));
          },
        },
      },
    ),
    createDoctorHealthContribution(
      "doctor:startup-channel-maintenance",
      "Startup channel maintenance",
      {
        healthChecks: [
          {
            id: "core/doctor/channel-plugin-blockers",
            description: "Configured channels must have loadable backing channel plugins.",
            defaultEnabled: false,
            async detect(ctx) {
              const {
                channelPluginBlockerHitToHealthFinding,
                scanConfiguredChannelPluginBlockers,
              } = await import("../commands/doctor/shared/channel-plugin-blockers.js");
              return scanConfiguredChannelPluginBlockers(ctx.cfg, process.env).map(
                channelPluginBlockerHitToHealthFinding,
              );
            },
          },
          {
            id: "core/doctor/channel-preview-warnings",
            description: "Channel doctor preview warnings are captured as structured findings.",
            defaultEnabled: false,
            async detect(ctx) {
              const { collectChannelPreviewWarningHealthFindings } =
                await import("./doctor-startup-channel-maintenance.js");
              return collectChannelPreviewWarningHealthFindings({
                cfg: ctx.cfg,
                allowExec: ctx.allowExecSecretRefs === true,
              });
            },
          },
        ],
        run: runStartupChannelMaintenanceHealth,
      },
    ),
    createDoctorHealthContribution("doctor:security", "Security", {
      updateWork: { kind: "inspection", scope: "agent" },
      healthCheckIds: ["core/doctor/security"],
      run: runSecurityHealth,
    }),
    createDoctorHealthContribution("doctor:web-fetch-proxy", "Web fetch proxy", {
      updateWork: { kind: "inspection", scope: "run" },
      run: runWebFetchProxyHealth,
    }),
    createDoctorHealthContribution("doctor:github-projects", "GitHub projects", {
      updateWork: { kind: "standalone" },
      run: runGitHubProjectHealth,
    }),
    createDoctorHealthContribution("doctor:browser", "Browser", {
      healthCheckIds: ["core/doctor/browser"],
      run: runBrowserHealth,
    }),
    createDoctorHealthContribution("doctor:oauth-tls", "OAuth TLS", {
      updateWork: { kind: "inspection", scope: "run" },
      healthCheckIds: ["core/doctor/oauth-tls"],
      run: runOpenAIOAuthTlsHealth,
    }),
    createDoctorHealthContribution("doctor:hooks-model", "Hooks model", {
      updateWork: { kind: "inspection", scope: "run" },
      healthCheckIds: ["core/doctor/hooks-model"],
      run: runHooksModelHealth,
    }),
    ...(
      [
        ["model-references", "Model references", "agent"],
        ["acp-agent-model", "ACP agent model", "agent"],
        ["provider-catalog-projection", "Provider catalog projection", "run"],
        ["local-audio-acceleration", "Local audio acceleration", "run"],
        ["runtime-tool-schemas", "Runtime tool schemas", "agent"],
        ["skill-workshop-tool-policy", "Skill Workshop tool policy", "agent"],
      ] as const
    ).map(([name, label, scope]) =>
      createDoctorHealthContribution(`doctor:${name}`, label, {
        updateWork: { kind: "inspection", scope },
        healthCheckIds: [`core/doctor/${name}`],
        run: (ctx) => runCoreHealthFindingNote(ctx, `core/doctor/${name}`),
      }),
    ),
    createDoctorHealthContribution("doctor:systemd-linger", "systemd linger", {
      healthChecks: {
        description: "Disabled systemd user lingering is reported as a finding.",
        defaultEnabled: false,
        detect: params.detectSystemdLingerFindings,
      },
      run: params.runSystemdLingerHealth,
    }),
    createDoctorHealthContribution("doctor:workspace-status", "Workspace status", {
      updateWork: { kind: "inspection", scope: "agent" },
      healthChecks: {
        description: "Workspace plugin/status diagnostics are exposed as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectWorkspaceStatusHealthFindings } =
            await import("../commands/doctor-workspace-status.js");
          const pluginVersionReadiness = await collectWorkspaceStatusPluginVersionReadiness({
            cfg: ctx.cfg,
            options: { nonInteractive: true, allowExec: ctx.allowExecSecretRefs === true },
          });
          const runWithPluginMetadataSnapshot = (ctx as DoctorHealthCheckContext)
            .runWithPluginMetadataSnapshot;
          return collectWorkspaceStatusHealthFindings(ctx.cfg, {
            pluginVersionReadiness,
            ...(runWithPluginMetadataSnapshot ? { runWithPluginMetadataSnapshot } : {}),
          });
        },
      },
      run: runWorkspaceStatusHealth,
    }),
    ...(isExperimentalClawsEnabled()
      ? [
          createDoctorHealthContribution("doctor:claws-state", "Claws state", {
            healthCheckIds: ["core/doctor/claws-state"],
            run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/claws-state"),
          }),
        ]
      : []),
    createDoctorHealthContribution("doctor:workspace-alias", "Workspace alias", {
      healthChecks: {
        description:
          "Persisted workspace aliases must resolve to the canonical target that owns their stored state.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectRepointedWorkspaceAliasFindings } =
            await import("../commands/doctor-workspace-alias.js");
          return collectRepointedWorkspaceAliasFindings(ctx.cfg);
        },
      },
      run: runWorkspaceAliasHealth,
    }),
    createDoctorHealthContribution("doctor:skills", "Skills", {
      updateWork: { kind: "inspection", scope: "agent", repairs: true },
      healthCheckIds: ["core/doctor/skills-readiness"],
      run: runSkillsHealth,
    }),
    createDoctorHealthContribution("doctor:bootstrap-size", "Bootstrap size", {
      updateWork: { kind: "standalone" },
      healthCheckIds: ["core/doctor/bootstrap-size"],
      run: runBootstrapSizeHealth,
    }),
    createDoctorHealthContribution(
      "doctor:heartbeat-cadence-migration",
      "Heartbeat cadence migration",
      {
        healthChecks: {
          description: "Heartbeat cadence config must be materialized in cron monitor rows.",
          defaultEnabled: true,
          async detect(ctx) {
            const { collectHeartbeatCadenceMigrationFindings } =
              await import("../commands/doctor-heartbeat-cadence-migration.js");
            return collectHeartbeatCadenceMigrationFindings(ctx.cfg, ctx.env);
          },
        },
        run: runHeartbeatCadenceMigrationHealth,
      },
    ),
    createDoctorHealthContribution(
      "doctor:heartbeat-scratch-migration",
      "Heartbeat scratch migration",
      {
        healthChecks: {
          description: "Workspace HEARTBEAT.md files must migrate into cron-owned scratch.",
          defaultEnabled: true,
          async detect(ctx) {
            const { collectHeartbeatScratchMigrationFindings } =
              await import("../commands/doctor-heartbeat-scratch-migration.js");
            return collectHeartbeatScratchMigrationFindings(ctx.cfg);
          },
        },
        run: runHeartbeatScratchMigrationHealth,
      },
    ),
    createDoctorHealthContribution("doctor:tools-md-migration", "TOOLS.md migration", {
      healthChecks: {
        description: "Workspace TOOLS.md notes must migrate into the AGENTS.md Tools section.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectToolsMdMigrationFindings } =
            await import("../commands/doctor-tools-md-migration.js");
          return collectToolsMdMigrationFindings(ctx.cfg);
        },
      },
      run: runToolsMdMigrationHealth,
    }),
    createDoctorHealthContribution(
      "doctor:heartbeat-task-cron-migration",
      "Heartbeat task cron migration",
      {
        healthChecks: {
          description: "Heartbeat scratch task blocks must migrate into automations.",
          defaultEnabled: true,
          async detect(ctx) {
            const { collectHeartbeatTaskMigrationFindings } =
              await import("../commands/doctor-heartbeat-task-migration.js");
            return collectHeartbeatTaskMigrationFindings(ctx.cfg, ctx.env);
          },
        },
        run: runHeartbeatTaskMigrationHealth,
      },
    ),
    createDoctorHealthContribution("doctor:shell-completion", "Shell completion", {
      healthCheckIds: ["core/doctor/shell-completion"],
      run: params.runShellCompletionHealth,
    }),
    createDoctorHealthContribution("doctor:gateway-health", "Gateway health", {
      healthCheckIds: ["core/doctor/gateway-health"],
      run: params.runGatewayHealthChecks,
    }),
    createDoctorHealthContribution("doctor:whatsapp-responsiveness", "WhatsApp responsiveness", {
      updateWork: { kind: "inspection", scope: "run" },
      healthChecks: {
        description: "Gateway pressure and local TUI observations when WhatsApp is enabled.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectWhatsappResponsivenessHealthFindings } =
            await import("../commands/doctor-whatsapp-responsiveness.js");
          const { bindAgentToolGatewayRequest } =
            await import("../agents/tools/in-process-gateway.js");
          const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
          let status: import("../status/summary.js").StatusSummary | undefined;
          if (
            !(
              (await hasActiveGatewayExecCredential({ cfg: ctx.cfg })) &&
              ctx.allowExecSecretRefs !== true
            )
          ) {
            const request = {
              method: "status",
              params: { includeChannelSummary: false },
              timeoutMs: 3000,
              config: ctx.cfg,
              deviceIdentity: null,
            };
            status = await requestGateway<import("../status/summary.js").StatusSummary>(
              request,
            ).catch(() => undefined);
          }
          return collectWhatsappResponsivenessHealthFindings({ cfg: ctx.cfg, status });
        },
      },
      run: runWhatsappResponsivenessHealth,
    }),
    createDoctorHealthContribution("doctor:memory-search", "Memory search", {
      updateWork: { kind: "inspection", scope: "agent", repairs: true },
      healthChecks: {
        description: "Memory search provider and backend readiness are captured as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectMemorySearchHealthFindings } =
            await import("../commands/doctor-memory-search.js");
          return collectMemorySearchHealthFindings(ctx);
        },
      },
      run: runMemorySearchHealthContribution,
    }),
    createDoctorHealthContribution("doctor:device-pairing", "Device pairing", {
      healthChecks: {
        description: "Device pairing requests and stale device-auth records are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectDevicePairingHealthFindings } =
            await import("../commands/doctor-device-pairing.js");
          return collectDevicePairingHealthFindings({
            cfg: ctx.cfg,
            healthOk: false,
            env: ctx.env,
          });
        },
      },
      run: runDevicePairingHealth,
    }),
    createDoctorHealthContribution("doctor:gateway-daemon", "Gateway daemon", {
      healthCheckIds: ["core/doctor/gateway-daemon"],
      run: runGatewayDaemonHealth,
    }),
    createDoctorHealthContribution("doctor:write-config", "Write config", {
      updateWork: { kind: "finalize" },
      healthChecks: {
        description: "Config write blockers are findings before doctor repair writes.",
        defaultEnabled: false,
        detect: collectWriteConfigHealthFindings,
      },
      async run(ctx) {
        await runWriteConfigHealth(ctx);
      },
    }),
    createDoctorHealthContribution("doctor:workspace-suggestions", "Workspace suggestions", {
      updateWork: { kind: "standalone" },
      healthCheckIds: ["core/doctor/workspace-suggestions"],
      run: runWorkspaceSuggestionsHealth,
    }),
    createDoctorHealthContribution("doctor:final-config-validation", "Final config validation", {
      updateWork: { kind: "finalize" },
      healthCheckIds: ["core/doctor/final-config-validation"],
      run: runFinalConfigValidationHealth,
    }),
  ];
}
