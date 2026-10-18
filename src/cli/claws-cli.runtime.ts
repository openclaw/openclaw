import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { filterStringEntries } from "@openclaw/normalization-core";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { applyClawAddPlanStateless } from "../claws/add-stateless.js";
import { CLAW_ADD_RESULT_SCHEMA_VERSION, ClawAddMutationError } from "../claws/add.js";
import {
  findClawExtensionPackageCollisions,
  planClawExtensions,
} from "../claws/application-plan.js";
import {
  assertClawsLabsEnabled,
  CLAWS_LABS_DISABLED_MESSAGE,
  ClawsLabsDisabledError,
  isClawsLabsEnabled,
} from "../claws/labs-gate.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import { preflightClawPackage } from "../claws/packages.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  CLAW_INSPECT_RESULT_SCHEMA_VERSION,
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
} from "../claws/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { readCurrentConfigForPolicyCheck } from "../config/io.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { resolveConfigPath } from "../config/paths.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawAgentConfiguration,
} from "./claws-cli-output.js";
import { waitUntilGatewayAgentAvailable } from "./claws-cli.gateway-readiness.js";
import type { ClawsAddOptions, ClawsInspectOptions } from "./claws-cli.js";
import { resolveClawPluginInstallConsent } from "./claws-cli.plugin-consent.js";
import {
  addPlanSkillWarnings,
  consentToClawSkillWarnings,
  logClawSkillWarnings,
} from "./claws-cli.skill-consent.js";
import { offlineClawAction } from "./claws-cli.state-owner.js";
import { listCronJobsFromGateway } from "./cron-cli/list-jobs.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { resolvePluginBatchReload } from "./plugins-lifecycle-client.js";
import { promptYesNo } from "./prompt.js";

function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  logClawAgentConfiguration(plan, runtime);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(`  Requirement ${action.target}: ${requirementState}`);
  }
  logClawSkillWarnings(addPlanSkillWarnings(plan), runtime);
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = action.details as Record<string, unknown> | undefined;
    const target =
      typeof server?.url === "string"
        ? redactSensitiveUrlLikeString(server.url)
        : typeof server?.command === "string"
          ? redactSensitiveArgv([server.command, ...filterStringEntries(server.args)]).join(" ")
          : "invalid declaration";
    runtime.log(`  MCP ${action.id}: ${target}`);
  }
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

export async function runClawsInspectCommand(
  sourcePath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const config = getRuntimeConfig();
  const extensionPlan = await planClawExtensions({
    extensions: result.openClawProfile?.extensions ?? [],
    workspace: result.source.packageRoot,
    packagePreflight: (pkg, workspace) => preflightClawPackage(pkg, workspace, { config }),
  });
  const extensionCollisions = findClawExtensionPackageCollisions({
    packages: result.manifest.packages,
    extensions: result.openClawProfile?.extensions ?? [],
  });
  const diagnostics = [
    ...result.diagnostics,
    ...extensionPlan.blockers,
    ...extensionCollisions.map(({ diagnostic }) => diagnostic),
  ];
  const valid = diagnostics.every((diagnostic) => diagnostic.level !== "error");
  const payload = {
    schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    valid,
    source: result.source,
    manifest: result.manifest,
    ...(result.openClawProfile ? { openClawProfile: result.openClawProfile } : {}),
    extensions: extensionPlan.extensions,
    diagnostics,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    if (!valid) {
      runtime.exit(1);
    }
    return;
  }
  runtime.log(`Claw: ${result.source.name}@${result.source.version}`);
  runtime.log(`Agent: ${result.manifest.agent.name ?? result.manifest.agent.id}`);
  runtime.log(`Packages: ${result.manifest.packages.length}`);
  runtime.log(`Extension requirements: ${extensionPlan.extensions.length}`);
  for (const extension of extensionPlan.extensions) {
    runtime.log(
      `  ${extension.id}: ${extension.requirementState}; ${extension.detectedFormat ?? "unresolved"} -> ${(extension.mapped ?? []).join(", ") || "no mapped capabilities"}`,
    );
  }
  runtime.log(`MCP servers: ${Object.keys(result.manifest.mcpServers).length}`);
  runtime.log(`Cron jobs: ${result.manifest.cronJobs.length}`);
  if (!valid) {
    runtime.error(formatClawDiagnostics(diagnostics));
    runtime.exit(1);
  }
}

export const runClawsAddCommand = offlineClawAction("add", runClawsAddCommandLocal);

async function runClawsAddCommandLocal(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const config = getRuntimeConfig();
  if (!isClawsLabsEnabled(config)) {
    emitClawFailure(runtime, opts.json, CLAWS_LABS_DISABLED_MESSAGE, {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: "claws_labs_disabled", message: CLAWS_LABS_DISABLED_MESSAGE },
    });
    return;
  }

  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const existingAgentIds = listAgentIds(config);
  const plan = await buildClawAddPlan({
    manifest: result.manifest,
    clawMarkdownBody: result.clawMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    openClawProfile: result.openClawProfile,
    source: result.source,
    diagnostics: result.diagnostics,
    context: {
      config,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      existingAgentIds,
      existingWorkspacePaths: existingAgentIds.map((agentId) =>
        resolveAgentWorkspaceDir(config, agentId),
      ),
      existingMcpServers: listedMcpServers.mcpServers,
      packagePreflight: (pkg: Parameters<typeof preflightClawPackage>[0], workspace: string) =>
        preflightClawPackage(pkg, workspace, { config }),
    },
  });

  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawAddPlanSummary(plan, runtime);
      runtime.error(formatClawDiagnostics(plan.blockers));
    }
    runtime.exit(1);
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      runtime.log(`Claw add preview: ${plan.claw.name}@${plan.claw.version}`);
      logClawAddPlanSummary(plan, runtime);
    }
    return;
  }

  const warnedPackages = plan.actions.flatMap((action) => {
    const details = action.details;
    return action.kind === "package" &&
      details?.ownerAction === "install" &&
      typeof details.riskWarning === "string" &&
      details.riskWarning
      ? [{ target: action.target, warning: details.riskWarning }]
      : [];
  });
  let riskApproved = Boolean(opts.acknowledgeClawhubRisk);
  if (warnedPackages.length > 0 && !riskApproved) {
    if (process.stdin.isTTY && process.stdout.isTTY && !opts.json) {
      runtime.log("ClawHub trust warnings:");
      for (const { target, warning } of warnedPackages) {
        runtime.log(redactSensitiveText(`  ${target}: ${warning}`));
      }
      riskApproved = await promptYesNo("Acknowledge these warnings and Add the Claw?");
    }
    if (!riskApproved) {
      const message =
        "ClawHub trust warnings require --acknowledge-clawhub-risk or interactive confirmation.";
      emitClawFailure(runtime, opts.json, message, {
        schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        status: "failed",
        error: { code: "clawhub_risk_acknowledgement_required", message },
        warnings: warnedPackages,
      });
      return;
    }
  }

  const hasPluginInstall = plan.actions.some(
    (action) =>
      action.kind === "package" &&
      action.details?.kind === "plugin" &&
      action.details.ownerAction === "install",
  );
  if (
    hasPluginInstall &&
    !opts.acceptCapabilities &&
    (!process.stdin.isTTY || !process.stdout.isTTY || opts.json)
  ) {
    const message = "Plugin capabilities require --accept-capabilities in a non-interactive Add.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code: "plugin_capability_consent_required", message },
    });
    return;
  }

  const skillConsent = consentToClawSkillWarnings(addPlanSkillWarnings(plan));
  let addResult;
  try {
    const configPath = resolveConfigPath();
    const configEnv = process.env;
    const assertCurrentLab = () =>
      assertClawsLabsEnabled(readCurrentConfigForPolicyCheck({ configPath, env: configEnv }));
    assertCurrentLab();
    addResult = await withOpenClawStateLease(
      {
        scope: "core:agent-deletion",
        key: plan.agent.finalId,
        database: { scope: "shared", options: {} },
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        leaseLabel: "Claw add",
        operationLabel: "claw.add.lease",
      },
      async (lease) => {
        assertCurrentLab();
        return await applyClawAddPlanStateless(plan, {
          config,
          assertCurrent: () => lease.assertOwned(),
          assertForwardCurrent: assertCurrentLab,
          pluginConsent: resolveClawPluginInstallConsent(runtime, {
            acceptCapabilities: opts.acceptCapabilities,
            approveClawHubRisk: riskApproved && warnedPackages.length > 0,
          }),
          ...(skillConsent ? { skillConsent } : {}),
          reloadPlugins: await resolvePluginBatchReload(),
          consentPlanIntegrity: plan.planIntegrity,
          runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
          cronGateway: {
            add: async (input) => await callGatewayFromCli("cron.add", {}, input),
            list: async (agentId) =>
              await listCronJobsFromGateway({}, { agentId, includeDisabled: true }),
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
            waitUntilAgentAvailable: waitUntilGatewayAgentAvailable,
          },
        });
      },
    );
  } catch (error) {
    const code =
      error instanceof ClawsLabsDisabledError
        ? "claws_labs_disabled"
        : error instanceof ClawAddMutationError
          ? error.code
          : "add_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, addResult);
  } else {
    runtime.log(`Added agent: ${addResult.agent.finalId}`);
    runtime.log(`Workspace: ${addResult.agent.workspace}`);
    if (addResult.error) {
      runtime.error(addResult.error.message);
    }
  }
  if (addResult.status !== "complete") {
    runtime.exit(1);
  }
}
