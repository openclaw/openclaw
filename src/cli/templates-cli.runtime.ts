import { existsSync } from "node:fs";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { filterStringEntries } from "@openclaw/normalization-core";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { readCurrentConfigForPolicyCheck } from "../config/io.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { resolveConfigPath } from "../config/paths.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveText } from "../logging/redact.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { applyTemplateAddPlanStateless } from "../templates/add-stateless.js";
import { TEMPLATE_ADD_RESULT_SCHEMA_VERSION, TemplateAddMutationError } from "../templates/add.js";
import {
  ClawHubSourceError,
  withResolvedClawHubSource,
  type ClawHubTemplateTrust,
} from "../templates/clawhub-source.js";
import { templateDependencyInventory } from "../templates/dependency-inventory.js";
import {
  assertTemplatesLabsEnabled,
  TEMPLATES_LABS_DISABLED_MESSAGE,
  TemplatesLabsDisabledError,
  isTemplatesLabsEnabled,
} from "../templates/labs-gate.js";
import { buildTemplateAddPlan } from "../templates/lifecycle.js";
import {
  preflightTemplatePackage,
  type TemplateSkillInstallConsent,
} from "../templates/packages.js";
import { readTemplateManifestFile } from "../templates/reader.js";
import { isCanonicalClawHubPackageName } from "../templates/schema-portability.js";
import { collectTemplateSkillWarningReviews } from "../templates/skill-warning-review.js";
import {
  TEMPLATE_INSPECT_RESULT_SCHEMA_VERSION,
  TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
  TEMPLATE_OUTPUT_STABILITY,
  type TemplateAddPlan,
  type TemplateReadResult,
} from "../templates/types.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { resolvePluginBatchReload } from "./plugins-lifecycle-client.js";
import { promptYesNo } from "./prompt.js";
import {
  emitTemplateFailure,
  formatTemplateDiagnostics,
  logTemplateAgentConfiguration,
} from "./templates-cli-output.js";
import type { TemplatesAddOptions, TemplatesInspectOptions } from "./templates-cli.js";

type TemplateCliSkillWarning =
  import("../templates/package-install-options.js").TemplateSkillWarning;
function addPlanSkillWarnings(plan: TemplateAddPlan): TemplateCliSkillWarning[] {
  return collectTemplateSkillWarningReviews(plan).map(({ actionId, ...warning }) => {
    if (
      actionId !== ("path" in warning ? `skill:bundled:${warning.path}` : `skill:${warning.ref}`)
    ) {
      throw new Error("The Template skill trust review is incomplete.");
    }
    return warning;
  });
}

function logTemplateAddPlanSummary(plan: TemplateAddPlan): void {
  runtime.log(`Agent: ${sanitizeTerminalText(plan.agent.finalId)}`);
  runtime.log(`Workspace: ${sanitizeTerminalText(plan.agent.workspace)}`);
  logTemplateAgentConfiguration(plan);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(`  Requirement ${sanitizeTerminalText(action.target)}: ${requirementState}`);
  }
  const skillWarnings = addPlanSkillWarnings(plan);
  if (skillWarnings.length > 0) {
    runtime.log(`Skill trust warnings (${skillWarnings.length}):`);
    for (const warning of skillWarnings) {
      runtime.log(
        redactSensitiveText(
          "path" in warning
            ? `  bundled:${warning.path} (${warning.digest})`
            : `  ${warning.ref}@${warning.version} (${warning.integrity})`,
        ),
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
    runtime.log(`  MCP ${sanitizeTerminalText(action.id)}: ${sanitizeTerminalText(target)}`);
  }
  runtime.log(`Automations: ${plan.summary.cronJobActions}`);
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

export async function runTemplatesInspectCommand(
  sourcePath: string,
  opts: TemplatesInspectOptions,
): Promise<void> {
  const result = await readTemplateManifestFile(sourcePath);
  if (!result.ok) {
    emitTemplateFailure(opts.json, formatTemplateDiagnostics(result.diagnostics), {
      schemaVersion: TEMPLATE_INSPECT_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const inventory = templateDependencyInventory(result.manifest, result.snapshot.bundledSources);
  const diagnostics = result.diagnostics;
  const valid = diagnostics.every((diagnostic) => diagnostic.level !== "error");
  const payload = {
    schemaVersion: TEMPLATE_INSPECT_RESULT_SCHEMA_VERSION,
    stability: TEMPLATE_OUTPUT_STABILITY,
    valid,
    source: result.source,
    manifest: result.manifest,
    inventory,
    diagnostics,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    if (!valid) {
      runtime.exit(1);
    }
    return;
  }
  runtime.log(
    `Template: ${sanitizeTerminalText(result.source.name)}@${sanitizeTerminalText(result.source.version)}`,
  );
  runtime.log(
    `Agent: ${sanitizeTerminalText(result.manifest.agent.name ?? result.manifest.agent.id)}`,
  );
  runtime.log(`Skills: ${result.manifest.skills.length}`);
  runtime.log(`Plugins: ${result.manifest.plugins.length}`);
  runtime.log(`MCP servers: ${Object.keys(result.manifest.mcpServers).length}`);
  runtime.log(`Automations: ${result.manifest.automations.length}`);
  if (!valid) {
    runtime.error(formatTemplateDiagnostics(diagnostics));
    runtime.exit(1);
  }
}

// Preview inspects existing state; only Add acquires mutation ownership.
export async function runTemplatesAddCommand(
  sourcePath: string,
  opts: TemplatesAddOptions,
): Promise<void> {
  const run = async () => {
    const config = opts.dryRun
      ? readCurrentConfigForPolicyCheck({ configPath: resolveConfigPath(), env: process.env })
      : getRuntimeConfig();
    if (!isTemplatesLabsEnabled(config)) {
      emitTemplateFailure(opts.json, TEMPLATES_LABS_DISABLED_MESSAGE, {
        schemaVersion: TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
        stability: TEMPLATE_OUTPUT_STABILITY,
        ok: false,
        error: { code: "templates_labs_disabled", message: TEMPLATES_LABS_DISABLED_MESSAGE },
      });
      return;
    }

    if (existsSync(sourcePath) || !isCanonicalClawHubPackageName(sourcePath)) {
      return await runTemplatesAddFromSource(
        await readTemplateManifestFile(sourcePath),
        opts,
        config,
      );
    }
    let sourceRunStarted = false;
    let sourceRunFinished = false;
    try {
      await withResolvedClawHubSource({
        coordinate: { packageName: sourcePath },
        mode: opts.dryRun ? "preview" : "apply",
        acknowledgeClawHubRisk: opts.acknowledgeClawhubRisk,
        run: async (source, trust) => {
          sourceRunStarted = true;
          await runTemplatesAddFromSource(source, opts, config, trust);
          sourceRunFinished = true;
        },
      });
    } catch (error) {
      // Cleanup must not replace an already reported Add outcome.
      if (sourceRunFinished) {
        runtime.error("Template source cleanup failed after Add; temporary files may remain.");
        return;
      }
      if (sourceRunStarted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      emitTemplateFailure(opts.json, message, {
        schemaVersion: TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
        stability: TEMPLATE_OUTPUT_STABILITY,
        ok: false,
        error: {
          code: error instanceof ClawHubSourceError ? error.code : "clawhub_source_failed",
          message,
        },
        ...(error instanceof ClawHubSourceError && error.warning
          ? { trustWarning: error.warning }
          : {}),
      });
    }
  };
  if (opts.dryRun) {
    return await withArtifactPreservingStateReads(() => withOpenClawStateDatabaseReadSnapshot(run));
  }
  return await runWithLocalStateOwner({
    method: "templates.add",
    params: {},
    target: "Template configuration and provenance",
    onForeignOwner: async ({ requestOwner }) => {
      const { runTemplatesAddThroughOwner } = await import("./templates-cli.gateway-add.js");
      await runTemplatesAddThroughOwner(sourcePath, opts, requestOwner);
    },
    runLocal: run,
  });
}

async function runTemplatesAddFromSource(
  result: TemplateReadResult,
  opts: TemplatesAddOptions,
  config: OpenClawConfig,
  trust?: ClawHubTemplateTrust,
): Promise<void> {
  if (!result.ok) {
    emitTemplateFailure(opts.json, formatTemplateDiagnostics(result.diagnostics), {
      schemaVersion: TEMPLATE_ADD_PLAN_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const listedMcpServers = await listConfiguredMcpServers(
    opts.dryRun ? { observe: false } : undefined,
  );
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const existingAgentIds = listAgentIds(config);
  const plan = await buildTemplateAddPlan({
    manifest: result.manifest,
    templateMarkdownBody: result.templateMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    bundledSources: result.snapshot.bundledSources,
    source: result.source,
    diagnostics: result.diagnostics,
    context: {
      config,
      agentId: opts.agentId,
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
      existingAgentIds,
      existingWorkspacePaths: existingAgentIds.map((agentId) =>
        resolveAgentWorkspaceDir(config, agentId),
      ),
      existingMcpServers: listedMcpServers.mcpServers,
      packagePreflight: (pkg, workspace, sourceContext) =>
        preflightTemplatePackage(pkg, workspace, { config, ...sourceContext }),
    },
  });

  const preview = {
    ...plan,
    ...(trust
      ? {
          trustWarning: trust.trustWarning,
          riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
        }
      : {}),
  };
  if (trust?.trustWarning && !opts.json) {
    runtime.log(redactSensitiveText(`ClawHub trust warning: ${trust.trustWarning}`));
  }
  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, preview);
    } else {
      logTemplateAddPlanSummary(plan);
      runtime.error(formatTemplateDiagnostics(plan.blockers));
    }
    runtime.exit(1);
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      writeRuntimeJson(runtime, preview);
    } else {
      runtime.log(
        `Template add preview: ${sanitizeTerminalText(plan.template.name)}@${sanitizeTerminalText(plan.template.version)}`,
      );
      logTemplateAddPlanSummary(plan);
    }
    return;
  }

  if (plan.summary.cronJobActions > 0) {
    const message =
      "Template automations require a running Gateway. Start the Gateway and Add a published ClawHub package by name without --workspace. For local sources, use --dry-run or publish the Template to ClawHub first.";
    emitTemplateFailure(opts.json, message, {
      schemaVersion: TEMPLATE_ADD_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      status: "failed",
      error: { code: "automation_requires_gateway", message },
    });
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
      runtime.log("Dependency trust warnings:");
      for (const { target, warning } of warnedPackages) {
        runtime.log(redactSensitiveText(`  ${target}: ${warning}`));
      }
      riskApproved = await promptYesNo("Acknowledge these warnings and Add the Template?");
    }
    if (!riskApproved) {
      const message =
        "Dependency trust warnings require --acknowledge-clawhub-risk or interactive confirmation.";
      emitTemplateFailure(opts.json, message, {
        schemaVersion: TEMPLATE_ADD_RESULT_SCHEMA_VERSION,
        stability: TEMPLATE_OUTPUT_STABILITY,
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
    emitTemplateFailure(opts.json, message, {
      schemaVersion: TEMPLATE_ADD_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
      status: "failed",
      error: { code: "plugin_capability_consent_required", message },
    });
    return;
  }

  const warnings = addPlanSkillWarnings(plan);
  let skillConsent: TemplateSkillInstallConsent | undefined;
  if (warnings.length > 0) {
    const byRef = new Map<string, TemplateCliSkillWarning>();
    for (const warning of warnings) {
      if (byRef.has("path" in warning ? `bundled:${warning.path}` : warning.ref)) {
        throw new Error("The Template skill trust review contains a duplicate package.");
      }
      byRef.set("path" in warning ? `bundled:${warning.path}` : warning.ref, warning);
    }
    skillConsent = {
      assertApproved: (pkg) => {
        const reviewed = byRef.get("path" in pkg ? `bundled:${pkg.path}` : pkg.ref);
        if (
          !reviewed ||
          ("path" in pkg
            ? !("path" in reviewed) ||
              reviewed.path !== pkg.path ||
              reviewed.name !== pkg.name ||
              reviewed.digest !== pkg.digest
            : !("ref" in reviewed) ||
              reviewed.version !== pkg.version ||
              reviewed.integrity !== pkg.integrity) ||
          reviewed.riskWarning !== pkg.riskWarning
        ) {
          throw new Error("Skill trust state changed; review the Template again.");
        }
      },
    };
  }
  let addResult;
  try {
    const configPath = resolveConfigPath();
    const configEnv = process.env;
    const assertCurrentLab = () =>
      assertTemplatesLabsEnabled(readCurrentConfigForPolicyCheck({ configPath, env: configEnv }));
    assertCurrentLab();
    addResult = await withOpenClawStateLease(
      {
        scope: "core:agent-deletion",
        key: plan.agent.finalId,
        database: { scope: "shared", options: {} },
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        leaseLabel: "Template add",
        operationLabel: "template.add.lease",
      },
      async (lease) => {
        assertCurrentLab();
        const onCapabilityConsent = resolvePluginCapabilityConsentCliOptions({
          action: "install",
          acceptCapabilities: opts.acceptCapabilities,
          runtime,
        }).onCapabilityConsent;
        return await applyTemplateAddPlanStateless(plan, {
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
        });
      },
    );
  } catch (error) {
    const code =
      error instanceof TemplatesLabsDisabledError
        ? "templates_labs_disabled"
        : error instanceof TemplateAddMutationError
          ? error.code
          : "add_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitTemplateFailure(opts.json, message, {
      schemaVersion: TEMPLATE_ADD_RESULT_SCHEMA_VERSION,
      stability: TEMPLATE_OUTPUT_STABILITY,
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
