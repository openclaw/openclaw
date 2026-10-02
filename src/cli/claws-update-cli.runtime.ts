import {
  ClawHubSourceError,
  readMatchingCachedClawHubSource,
  withResolvedClawHubSource,
} from "../claws/clawhub-source.js";
import {
  assertClawsLabsEnabled,
  CLAWS_LABS_DISABLED_MESSAGE,
  ClawsLabsDisabledError,
  isClawsLabsEnabled,
} from "../claws/labs-gate.js";
import { readClawStatus } from "../claws/lifecycle-state.js";
import { withAuthoredAgentRoster } from "../claws/migrate-validation.js";
import { preflightClawPackage } from "../claws/packages.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
  type ClawReadResult,
  type ClawSourceIdentity,
} from "../claws/types.js";
import {
  applyClawUpdatePlan,
  CLAW_UPDATE_RESULT_SCHEMA_VERSION,
  ClawUpdateMutationError,
} from "../claws/update-apply.js";
import { buildClawUpdatePlan, CLAW_UPDATE_PLAN_SCHEMA_VERSION } from "../claws/update-plan.js";
import { getRuntimeConfig } from "../config/config.js";
import { readCurrentConfigForPolicyCheck } from "../config/io.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { resolveConfigPath } from "../config/paths.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawExperimentalWarning,
  logClawUpdatePlanSummary,
} from "./claws-cli-output.js";
import { waitUntilGatewayAgentAvailable } from "./claws-cli.gateway-readiness.js";
import type { ClawsUpdateOptions } from "./claws-cli.js";
import { resolveClawPluginInstallConsent } from "./claws-cli.plugin-consent.js";
import {
  consentToClawSkillWarnings,
  logClawSkillWarnings,
  updatePlanSkillWarnings,
} from "./claws-cli.skill-consent.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { resolvePluginBatchReload } from "./plugins-lifecycle-client.js";

export async function runClawsUpdateCommand(
  target: string,
  opts: ClawsUpdateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (!isClawsLabsEnabled(getRuntimeConfig())) {
    emitClawFailure(runtime, opts.json, CLAWS_LABS_DISABLED_MESSAGE, {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: "claws_labs_disabled", message: CLAWS_LABS_DISABLED_MESSAGE },
    });
    return;
  }
  if (!opts.dryRun && (!opts.yes || !opts.planIntegrity)) {
    const message =
      "Claw update requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to apply supported actions.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: "consent_required", message },
    });
    return;
  }

  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    emitClawFailure(runtime, opts.json, listedMcpServers.error, {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      valid: false,
      diagnostics: [
        {
          level: "error",
          code: "mcp_config_unavailable",
          phase: "plan",
          path: "$.mcpServers",
          message: listedMcpServers.error,
        },
      ],
    });
    return;
  }
  const config = withAuthoredAgentRoster(
    listedMcpServers.runtimeConfig ?? listedMcpServers.config,
    listedMcpServers.sourceConfigBeforeMigrations,
  );
  let source = opts.from;
  let recordedSource: ClawSourceIdentity | undefined;
  if (!source) {
    const database = await openExistingOpenClawStateDatabaseReadOnly();
    let status: Awaited<ReturnType<typeof readClawStatus>> | { records: never[] } = {
      records: [],
    };
    if (database) {
      try {
        const hasClawInstalls =
          database.db /* sqlite-allow-raw: read-only Claw install table-existence probe. */
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
            .get();
        if (hasClawInstalls) {
          status = await readClawStatus(target, {
            database,
            readOnly: true,
            sourceMcpServers: listedMcpServers.mcpServers,
          });
        }
      } finally {
        database.walMaintenance.close();
      }
    }
    if (status.records.length !== 1) {
      const message =
        status.records.length === 0
          ? `No installed Claw agent matches ${JSON.stringify(target)}.`
          : `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`;
      emitClawFailure(runtime, opts.json, message, {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: true,
        mutationAllowed: false,
        valid: false,
        diagnostics: [
          {
            level: "error",
            code: status.records.length === 0 ? "claw_not_found" : "claw_ambiguous",
            phase: "plan",
            path: "$",
            message,
          },
        ],
      });
      return;
    }
    const recorded = status.records[0]!.install.claw;
    recordedSource = recorded;
    source = recorded.kind === "package" ? recorded.packageRoot : recorded.manifestPath;
  }

  let loaded: ClawReadResult;
  if (!opts.from && recordedSource?.integrityKind === "artifact") {
    try {
      const recorded = recordedSource;
      const resolved = await withResolvedClawHubSource({
        coordinate: { packageName: recorded.name, version: recorded.version },
        mode: opts.dryRun ? "preview" : "apply",
        ...(!opts.dryRun && opts.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
        run: async (verified, trust) =>
          await readMatchingCachedClawHubSource({ recorded, verified, trust }),
      });
      loaded = resolved.value;
    } catch (error) {
      const code = error instanceof ClawHubSourceError ? error.code : "clawhub_source_unavailable";
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = [
        { level: "error" as const, code, phase: "plan" as const, path: "$", message },
      ];
      emitClawFailure(runtime, opts.json, formatClawDiagnostics(diagnostics), {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: true,
        mutationAllowed: false,
        valid: false,
        diagnostics,
      });
      return;
    }
  } else {
    loaded = await readClawManifestFile(source, {
      allowLegacyDynamicToolProfile: !opts.from,
    });
  }
  if (!loaded.ok) {
    const diagnostics = opts.from
      ? loaded.diagnostics
      : [
          ...loaded.diagnostics,
          {
            level: "error" as const,
            code: "recorded_source_unavailable",
            phase: "plan" as const,
            path: "$",
            message: "The recorded Claw source is unavailable; pass --from to override it.",
          },
        ];
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(diagnostics), {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      valid: false,
      diagnostics,
    });
    return;
  }

  let targetAddPlan: ClawAddPlan | undefined;
  const plan = await buildClawUpdatePlan({
    agentId: target,
    targetManifest: loaded.manifest,
    targetClawMarkdownBody: loaded.clawMarkdownBody,
    targetOpenClawProfile: loaded.openClawProfile,
    targetSource: loaded.source,
    config,
    sourceMcpServers: listedMcpServers.mcpServers,
    packagePreflight: (pkg, workspace) => preflightClawPackage(pkg, workspace, { config }),
    captureGatewayProjection: (_desiredAgent, addPlan) => {
      targetAddPlan = addPlan;
    },
    diagnostics: loaded.diagnostics,
  });
  const skillWarnings = updatePlanSkillWarnings({ plan, targetAddPlan });
  if (opts.dryRun || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    if (opts.json) {
      writeRuntimeJson(runtime, { ...plan, skillWarnings });
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(
        `Claw update plan: ${plan.currentClaw?.name ?? target} ${plan.currentClaw?.version ?? "unknown"} -> ${plan.targetClaw?.version ?? "unknown"}`,
      );
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      logClawUpdatePlanSummary(plan, runtime);
      logClawSkillWarnings(skillWarnings, runtime);
    }
    if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
      runtime.exit(1);
    }
    return;
  }

  if (opts.planIntegrity !== plan.planIntegrity) {
    const message = "The consented Claw plan no longer matches; run update --dry-run again.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code: "plan_integrity_mismatch", message },
    });
    return;
  }
  const skillConsent = consentToClawSkillWarnings(skillWarnings);

  try {
    const configPath = resolveConfigPath();
    const configEnv = process.env;
    const assertCurrentLab = () =>
      assertClawsLabsEnabled(readCurrentConfigForPolicyCheck({ configPath, env: configEnv }));
    assertCurrentLab();
    const result = await withOpenClawStateLease(
      {
        scope: "core:agent-deletion",
        key: plan.agentId,
        database: { scope: "shared", options: {} },
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        leaseLabel: "Claw update",
        operationLabel: "claw.update.lease",
      },
      async (lease) => {
        assertCurrentLab();
        return await applyClawUpdatePlan(
          plan,
          {
            targetManifest: loaded.manifest,
            targetClawMarkdownBody: loaded.clawMarkdownBody,
            targetOpenClawProfile: loaded.openClawProfile,
            targetSource: loaded.source,
          },
          {
            config,
            assertCurrent: () => lease.assertOwned(),
            assertForwardCurrent: assertCurrentLab,
            pluginConsent: resolveClawPluginInstallConsent(runtime),
            ...(skillConsent ? { skillConsent } : {}),
            reloadPlugins: await resolvePluginBatchReload(),
            sourceMcpServers: listedMcpServers.mcpServers,
            consentPlanIntegrity: opts.planIntegrity,
            packagePreflight: (pkg, workspace) => preflightClawPackage(pkg, workspace, { config }),
            runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
            cronGateway: {
              waitUntilAgentAvailable: waitUntilGatewayAgentAvailable,
              add: async (input) => await callGatewayFromCli("cron.add", {}, input),
              get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
              remove: async (id, options) =>
                await callGatewayFromCli(
                  "cron.remove",
                  {},
                  {
                    id,
                    expectedConfigRevision: options.expectedConfigRevision,
                  },
                ),
            },
          },
        );
      },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Updated agent: ${result.agentId}`);
    runtime.log(`Claw version: ${result.previousClaw.version} -> ${result.targetClaw.version}`);
  } catch (error) {
    const code =
      error instanceof ClawsLabsDisabledError
        ? "claws_labs_disabled"
        : error instanceof ClawUpdateMutationError
          ? error.code
          : "update_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: code === "update_partial" ? "partial" : "failed",
      error: { code, message },
    });
  }
}
