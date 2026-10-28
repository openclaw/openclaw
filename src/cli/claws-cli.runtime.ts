import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { filterStringEntries } from "@openclaw/normalization-core";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
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
import { resolveLocalClawSource } from "../claws/local-source.js";
import { preflightClawPackage, type ClawSkillInstallConsent } from "../claws/packages.js";
import { collectClawSkillWarningReviews } from "../claws/skill-warning-review.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { sleep } from "../utils/sleep.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawAgentConfiguration,
} from "./claws-cli-output.js";
import type { ClawsAddOptions, ClawsInspectOptions } from "./claws-cli.js";
import { listCronJobsFromGateway } from "./cron-cli/list-jobs.js";
import { callGatewayFromCli, callGatewayFromCliWithTransport } from "./gateway-rpc.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { resolvePluginBatchReload } from "./plugins-lifecycle-client.js";
import { promptYesNo } from "./prompt.js";

type ClawCliSkillWarning = {
  ref: string;
  version: string;
  integrity: string;
  riskWarning: string;
};

function addPlanSkillWarnings(plan: ClawAddPlan): ClawCliSkillWarning[] {
  return collectClawSkillWarningReviews(plan).map(({ actionId, ...warning }) => {
    if (actionId !== `skill:${warning.ref}`) {
      throw new Error("The Claw skill trust review is incomplete.");
    }
    return warning;
  });
}

const CLAW_AGENT_RELOAD_TIMEOUT_MS = 15_000;
const CLAW_AGENT_RELOAD_POLL_MS = 100;

function logClawAddPlanSummary(plan: ClawAddPlan): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  logClawAgentConfiguration(plan);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(`  Requirement ${action.target}: ${requirementState}`);
  }
  const skillWarnings = addPlanSkillWarnings(plan);
  if (skillWarnings.length > 0) {
    runtime.log(`Skill trust warnings (${skillWarnings.length}):`);
    for (const warning of skillWarnings) {
      runtime.log(
        redactSensitiveText(`  ${warning.ref}@${warning.version} (${warning.integrity})`),
      );
      runtime.log(redactSensitiveText(`    ${warning.riskWarning}`));
    }
    runtime.log("These warnings require explicit acknowledgement before Add.");
  }
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
): Promise<void> {
  await using source = await resolveLocalClawSource(sourcePath);
  const result = source.claw;
  if (!result.ok) {
    emitClawFailure(opts.json, formatClawDiagnostics(result.diagnostics), {
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
  runtime.log(
    `Agent: ${sanitizeTerminalText(result.manifest.agent.name ?? result.manifest.agent.id)}`,
  );
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

// Add's planning and application both read or mutate Gateway-owned state.
export async function runClawsAddCommand(sourcePath: string, opts: ClawsAddOptions): Promise<void> {
  return await runWithLocalStateOwner({
    method: "claws.add",
    params: {},
    target: "Claw configuration and provenance",
    onForeignOwner: "refuse",
    runLocal: async () => {
      const config = getRuntimeConfig();
      if (!isClawsLabsEnabled(config)) {
        emitClawFailure(opts.json, CLAWS_LABS_DISABLED_MESSAGE, {
          schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
          stability: CLAW_OUTPUT_STABILITY,
          ok: false,
          error: { code: "claws_labs_disabled", message: CLAWS_LABS_DISABLED_MESSAGE },
        });
        return;
      }

      await using source = await resolveLocalClawSource(sourcePath);
      const result = source.claw;
      if (!result.ok) {
        emitClawFailure(opts.json, formatClawDiagnostics(result.diagnostics), {
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
          logClawAddPlanSummary(plan);
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
          logClawAddPlanSummary(plan);
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
          emitClawFailure(opts.json, message, {
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
        const message =
          "Plugin capabilities require --accept-capabilities in a non-interactive Add.";
        emitClawFailure(opts.json, message, {
          schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
          stability: CLAW_OUTPUT_STABILITY,
          status: "failed",
          error: { code: "plugin_capability_consent_required", message },
        });
        return;
      }

      const warnings = addPlanSkillWarnings(plan);
      let skillConsent: ClawSkillInstallConsent | undefined;
      if (warnings.length > 0) {
        const byRef = new Map<string, ClawCliSkillWarning>();
        for (const warning of warnings) {
          if (byRef.has(warning.ref)) {
            throw new Error("The Claw skill trust review contains a duplicate package.");
          }
          byRef.set(warning.ref, warning);
        }
        skillConsent = {
          assertApproved: (pkg) => {
            const reviewed = byRef.get(pkg.ref);
            if (
              !reviewed ||
              reviewed.version !== pkg.version ||
              reviewed.integrity !== pkg.integrity ||
              reviewed.riskWarning !== pkg.riskWarning
            ) {
              throw new Error("Skill trust state changed; review the Claw again.");
            }
          },
        };
      }
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
            const onCapabilityConsent = resolvePluginCapabilityConsentCliOptions({
              action: "install",
              acceptCapabilities: opts.acceptCapabilities,
              runtime,
            }).onCapabilityConsent;
            return await applyClawAddPlanStateless(plan, {
              config,
              assertCurrent: () => lease.assertOwned(),
              assertForwardCurrent: assertCurrentLab,
              pluginConsent: {
                onCapabilityConsent: async (review) => await onCapabilityConsent?.(review),
                confirmInstall: async (_pluginId, warning) =>
                  !warning || (riskApproved && warnedPackages.length > 0),
              },
              ...(skillConsent ? { skillConsent } : {}),
              reloadPlugins: await resolvePluginBatchReload(),
              consentPlanIntegrity: plan.planIntegrity,
              runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
              cronGateway: {
                add: async (input) => await callGatewayFromCli("cron.add", {}, input),
                list: async (agentId) =>
                  await listCronJobsFromGateway({}, { agentId, includeDisabled: true }),
                get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
                writeScratch: async (id, content, commitGuard) => {
                  commitGuard();
                  const scratchResult = await callGatewayFromCli(
                    "cron.scratch.set",
                    {},
                    {
                      id,
                      content,
                      expectedRevision: 0,
                    },
                  );
                  if (!scratchResult.ok) {
                    throw new Error("Claw automation scratch changed before import.");
                  }
                },
                enable: async (id, expectedConfigRevision, commitGuard) => {
                  commitGuard();
                  await callGatewayFromCli(
                    "cron.update",
                    {},
                    {
                      id,
                      patch: { enabled: true },
                      expectedConfigRevision,
                    },
                  );
                },
                remove: async (id, options) =>
                  await callGatewayFromCli(
                    "cron.remove",
                    {},
                    {
                      id,
                      expectedConfigRevision: options.expectedConfigRevision,
                    },
                  ),
                waitUntilAgentAvailable: async (agentId) => {
                  const deadline = monotonicNow() + CLAW_AGENT_RELOAD_TIMEOUT_MS;
                  let lastError: unknown;
                  while (monotonicNow() < deadline) {
                    try {
                      const response = await callGatewayFromCliWithTransport<{
                        config?: OpenClawConfig;
                        configRevisionHash?: unknown;
                        appliedConfigHash?: unknown;
                      }>("config.get", { timeout: "5000" }, {});
                      // Matching tokens can describe a cached roster from before this agent was added.
                      if (
                        Object.hasOwn(response.config?.agents?.entries ?? {}, agentId) &&
                        typeof response.configRevisionHash === "string" &&
                        response.configRevisionHash === response.appliedConfigHash
                      ) {
                        return;
                      }
                      lastError = undefined;
                    } catch (error) {
                      lastError = error;
                    }
                    await sleep(CLAW_AGENT_RELOAD_POLL_MS);
                  }
                  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
                  throw new Error(
                    `Gateway did not apply the Claw agent configuration in time${suffix}`,
                  );
                },
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
        emitClawFailure(opts.json, message, {
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
    },
  });
}
