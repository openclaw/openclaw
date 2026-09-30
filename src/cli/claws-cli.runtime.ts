import { stableStringify } from "@openclaw/normalization-core";
import { ClawAddMutationError } from "../claws/add-errors.js";
import { applyClawAddPlan, CLAW_ADD_RESULT_SCHEMA_VERSION } from "../claws/add.js";
import * as agentAdoptionApply from "../claws/agent-adoption-apply.js";
import {
  findClawExtensionPackageCollisions,
  planClawExtensions,
} from "../claws/application-plan.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import {
  CLAW_EXPORT_RESULT_SCHEMA_VERSION,
  ClawExportError,
  exportClawAgent,
} from "../claws/export.js";
import {
  applyClawRemovePlan,
  buildClawRemovePlan,
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  ClawRemoveError,
  readClawStatus,
} from "../claws/lifecycle-state.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import {
  findResumableIntroducedPluginRequirement,
  readClawResumeStateReadOnly,
} from "../claws/package-resume.js";
import { preflightClawPackage } from "../claws/packages.js";
import {
  clawInstallRecordMatchesPlan,
  readClawInstallRecord,
  readClawPackageRefs,
  type PersistedClawInstall,
} from "../claws/provenance.js";
import { readClawManifestFile } from "../claws/reader.js";
import {
  CLAW_INSPECT_RESULT_SCHEMA_VERSION,
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
} from "../claws/types.js";
import { readClawWorkspaceAdoption } from "../claws/workspace-origin.js";
import { readClawWorkspaceFiles } from "../claws/workspace.js";
// Runtime handlers for experimental local Claws commands.
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
} from "../cron/store.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { authorizeLegacyV1Resume } from "./claws-cli-legacy-resume.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawExperimentalWarning,
} from "./claws-cli-output.js";
import { waitUntilGatewayAgentAvailable } from "./claws-cli.gateway-readiness.js";
import type {
  ClawsAddOptions,
  ClawsExportOptions,
  ClawsInspectOptions,
  ClawsRemoveOptions,
  ClawsStatusOptions,
} from "./claws-cli.js";
import { clawMonitorCleanupGateway } from "./claws-cli.monitor-cleanup.js";
import { clawPackageRemovalGateway } from "./claws-cli.package-removal.js";
import { logClawAddPlanSummary, logClawRemovePlanSummary } from "./claws-cli.plan-console.js";
import { listCronJobsFromGateway } from "./cron-cli/list-jobs.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { resolvePluginBatchReload } from "./plugins-lifecycle-client.js";

async function matchingResumeState(
  plan: ClawAddPlan,
  opts: ClawsAddOptions,
  exactAdoptResumeCandidate: boolean,
) {
  const readOnlyState = opts.dryRun
    ? await readClawResumeStateReadOnly(plan.agent.finalId)
    : undefined;
  const record = opts.dryRun ? readOnlyState?.record : readClawInstallRecord(plan.agent.finalId);
  if (
    !record ||
    record.status === "complete" ||
    record.workspace !== plan.agent.workspace ||
    record.claw.kind !== plan.claw.kind ||
    record.claw.name !== plan.claw.name ||
    record.claw.version !== plan.claw.version ||
    record.claw.integrity !== plan.claw.integrity ||
    (record.agentOrigin === "adopted" && (!opts.adoptExistingAgent || !exactAdoptResumeCandidate))
  ) {
    return undefined;
  }
  return {
    record,
    packageRefs: readOnlyState?.packageRefs ?? readClawPackageRefs({ agentId: plan.agent.finalId }),
    // Mirrors packageRefs above: a dry-run preview reuses the read-only snapshot and never opens
    // the writable state database; a real apply (which is about to write anyway) reads fresh.
    workspaceAdoption:
      readOnlyState?.workspaceAdoption ??
      readClawWorkspaceAdoption(plan.agent.finalId, record.workspace),
    workspaceFiles: readOnlyState?.workspaceFiles ?? readClawWorkspaceFiles(plan.agent.finalId),
  };
}

function requireClawPlanConsent(
  action: "add" | "remove",
  opts: ClawsAddOptions | ClawsRemoveOptions,
  runtime: RuntimeEnv,
): boolean {
  if (opts.dryRun || (opts.yes && opts.planIntegrity)) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? `Claw ${action} consent must include --plan-integrity from the exact dry-run plan.`
    : `Claw ${action} requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to ${action === "add" ? "apply the reviewed Claw add plan" : "remove owned state"}.`;
  emitClawFailure(runtime, opts.json, message, {
    schemaVersion:
      action === "add" ? CLAW_ADD_PLAN_SCHEMA_VERSION : CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    ok: false,
    error: { code, message },
  });
  return true;
}

export async function runClawsInspectCommand(
  sourcePath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
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

  const extensionPlan = await planClawExtensions({
    extensions: result.openClawProfile?.extensions ?? [],
    workspace: result.source.packageRoot,
    packagePreflight: preflightClawPackage,
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
  logClawExperimentalWarning(runtime);
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

export async function runClawsAddCommand(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (requireClawPlanConsent("add", opts, runtime)) {
    return;
  }
  let legacyV1ResumeRecord: PersistedClawInstall | undefined;
  const result = await readClawManifestFile(sourcePath, {
    authorizeLegacyDynamicToolProfile: ({ manifest, source }) => {
      legacyV1ResumeRecord = authorizeLegacyV1Resume({ manifest, source, opts });
      return legacyV1ResumeRecord !== undefined;
    },
  });
  if (!result.ok) {
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }
  const config = getRuntimeConfig();
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const { configuredAgents, existingAgents, existingWorkspacePaths } =
    await agentAdoptionApply.readClawPlanningAgentRoster(config);
  const finalAgentId = opts.agentId ?? result.manifest.agent.id;
  const targetInstallRecord = opts.dryRun
    ? (await readClawResumeStateReadOnly(finalAgentId))?.record
    : readClawInstallRecord(finalAgentId);
  const exactAdoptResumeCandidate = agentAdoptionApply.isExactAdoptedAgentResumeCandidate({
    requested: opts.adoptExistingAgent === true,
    record: targetInstallRecord,
    liveAgent: configuredAgents.find((agent) => agent.id === finalAgentId),
  });
  const cronStore = await loadCronJobsStoreWithConfigJobsReadOnly(resolveCronJobsStorePath());
  const basePlanContext = {
    config,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.adoptExistingWorkspace ? { adoptExistingWorkspace: true } : {}),
    ...(opts.adoptExistingAgent ? { adoptExistingAgent: true } : {}),
    existingAgents,
    existingWorkspacePaths,
    managedAgentIds:
      targetInstallRecord && !exactAdoptResumeCandidate ? [targetInstallRecord.agentId] : [],
    existingMcpServers: listedMcpServers.mcpServers,
    existingCronJobIds: cronStore.store.jobs.map((job) => job.id),
    packagePreflight: preflightClawPackage,
  };
  const planInput = {
    manifest: result.manifest,
    clawMarkdownBody: result.clawMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    openClawProfile: result.openClawProfile,
    source: result.source,
    diagnostics: result.diagnostics,
  };
  let plan = await buildClawAddPlan({ ...planInput, context: basePlanContext });
  let legacyResumePlan = result.legacyOpenClawProfile
    ? await buildClawAddPlan({
        ...planInput,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        context: basePlanContext,
      })
    : undefined;
  let resumableInstallRecord: PersistedClawInstall | undefined;
  const resumeState = await matchingResumeState(
    legacyResumePlan ?? plan,
    opts,
    exactAdoptResumeCandidate,
  );
  if ((result.legacyOpenClawProfile || exactAdoptResumeCandidate) && !resumeState) {
    plan = {
      ...plan,
      blockers: [
        ...plan.blockers,
        {
          level: "error",
          code: "claw_resume_plan_mismatch",
          phase: "plan",
          path: "$",
          message:
            "The incomplete Claw add no longer matches the previously consented plan; remove its partial state before retrying.",
        },
      ],
    };
  }
  if (resumeState) {
    const {
      record: resumeRecord,
      packageRefs: resumePackageRefs,
      workspaceAdoption: resumeWorkspaceAdoption,
      workspaceFiles: resumeWorkspaceFiles,
    } = resumeState;
    resumableInstallRecord = resumeRecord;
    const packagePreflight = async (
      pkg: Parameters<typeof preflightClawPackage>[0],
      workspace: string,
    ) => {
      const preflight = await preflightClawPackage(pkg, workspace);
      return findResumableIntroducedPluginRequirement({
        agentId: resumeRecord.agentId,
        pkg,
        preflight,
        refs: resumePackageRefs,
      })
        ? { ...preflight, action: "install" as const }
        : preflight;
    };
    const canResumeWorkspace =
      resumeRecord.status === "workspace_ready" || resumeRecord.status === "config_committed";
    const expectedCommittedAgentConfigs = legacyResumePlan
      ? [legacyResumePlan.agent.config, plan.agent.config]
      : [plan.agent.config];
    const canResumeAgent = agentAdoptionApply.createdAgentMayBeAbsentDuringResume(
      resumeRecord,
      agentAdoptionApply.exactCommittedClawAgentExists({
        config,
        agentId: resumeRecord.agentId,
        expected: expectedCommittedAgentConfigs,
      }),
    );
    const otherAgentWorkspacePaths = new Set(
      existingAgents.flatMap((agent) =>
        agent.id !== resumeRecord.agentId && agent.resolvedWorkspace
          ? [agent.resolvedWorkspace]
          : [],
      ),
    );
    // Once a created agent has been committed, resume planning removes that roster entry so the
    // saved create action can be reconstructed. Remove its matching supplemental path too, while
    // retaining the path when another configured agent also claims it.
    const resumableExistingWorkspacePaths = canResumeAgent
      ? existingWorkspacePaths.filter(
          (path) => path !== resumeRecord.workspace || otherAgentWorkspacePaths.has(path),
        )
      : existingWorkspacePaths;
    // A resumed adoption re-plans by the operator's original consent, not disk presence: the
    // consented adopted-file ids and this install's already-written files must round-trip to the
    // same actions even though a prior attempt left them existing on disk. The marker row is
    // written at "pending" (before workspace_ready), so gate on canResumeWorkspace here rather
    // than trusting `.adopted` alone, or an abandoned pending attempt would look resumable.
    const workspaceOrigin = canResumeWorkspace ? resumeWorkspaceAdoption : undefined;
    const resumePlanContext = {
      ...basePlanContext,
      // A directory created by this install stays a create plan despite now existing on disk.
      adoptExistingWorkspace:
        basePlanContext.adoptExistingWorkspace && workspaceOrigin?.adopted !== false,
      packagePreflight,
      existingAgents: canResumeAgent
        ? existingAgents.filter((agent) => agent.id !== resumeRecord.agentId)
        : existingAgents,
      existingWorkspacePaths: resumableExistingWorkspacePaths,
      managedAgentIds: [],
      ...(canResumeWorkspace ? { resumableWorkspace: resumeRecord.workspace } : {}),
      ...(workspaceOrigin?.adopted
        ? {
            resumableWorkspaceOwnership: {
              adoptedFiles: workspaceOrigin.adoptedFiles,
              ownedFiles: resumeWorkspaceFiles,
              bootstrapPublication: workspaceOrigin.bootstrapPublication,
              filePublications: workspaceOrigin.filePublications,
            },
          }
        : {}),
    };
    plan = await buildClawAddPlan({ ...planInput, context: resumePlanContext });
    if (result.legacyOpenClawProfile) {
      legacyResumePlan = await buildClawAddPlan({
        ...planInput,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        context: resumePlanContext,
      });
    }
    const expectedResumePlan = legacyResumePlan ?? plan;
    const exactLegacyResume =
      !legacyResumePlan ||
      (legacyV1ResumeRecord !== undefined &&
        stableStringify(legacyV1ResumeRecord) === stableStringify(resumeRecord));
    if (
      plan.blockers.length === 0 &&
      (!exactLegacyResume || !clawInstallRecordMatchesPlan(resumeRecord, expectedResumePlan))
    ) {
      plan = {
        ...plan,
        blockers: [
          ...plan.blockers,
          {
            level: "error",
            code: "claw_resume_plan_mismatch",
            phase: "plan",
            path: "$",
            message:
              "The incomplete Claw add no longer matches the current plan; remove its partial state before retrying.",
          },
        ],
      };
    } else {
      resumableInstallRecord = resumeRecord;
    }
  }

  if (plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
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
      logClawExperimentalWarning(runtime);
      runtime.log(`Claw add plan: ${plan.claw.name}@${plan.claw.version}`);
      logClawAddPlanSummary(plan, runtime);
    }
    return;
  }

  const consentPlanIntegrity = legacyResumePlan?.planIntegrity ?? plan.planIntegrity;
  if (opts.planIntegrity !== consentPlanIntegrity) {
    const message = "The consented Claw plan no longer matches; run add --dry-run again.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      planIntegrity: plan.planIntegrity,
      error: { code: "plan_integrity_mismatch", message },
    });
    return;
  }

  let addResult;
  if (!opts.json) {
    logClawExperimentalWarning(runtime);
  }
  try {
    addResult = await applyClawAddPlan(plan, {
      reloadPlugins: await resolvePluginBatchReload(),
      consentPlanIntegrity: opts.planIntegrity,
      resumeRecord: resumableInstallRecord,
      resumePlan: legacyResumePlan,
      runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
      cronGateway: {
        add: async (input) => await callGatewayFromCli("cron.add", {}, input),
        list: async (agentId) =>
          await listCronJobsFromGateway({}, { agentId, includeDisabled: true }),
        waitUntilAgentAvailable: waitUntilGatewayAgentAvailable,
      },
    });
  } catch (error) {
    const code = error instanceof ClawAddMutationError ? error.code : "add_failed";
    const message = (error as Error).message;
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
    runtime.log(`Status: ${addResult.status}`);
    if (addResult.error) {
      runtime.error(addResult.error.message);
    }
  }
  if (addResult.status !== "complete") {
    runtime.exit(1);
  }
}

export async function runClawsStatusCommand(
  target: string | undefined,
  opts: ClawsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const status = await readClawStatus(target);
  if (opts.json) {
    writeRuntimeJson(runtime, status);
  } else {
    logClawExperimentalWarning(runtime);
    runtime.log(`Installed Claws: ${status.summary.claws}`);
    for (const record of status.records) {
      runtime.log(
        `${record.install.agentId}: ${record.install.claw.name}@${record.install.claw.version} (${record.install.status}; agent ${record.agentOrigin})`,
      );
      runtime.log(
        `  Agent: ${record.agentState}; bootstrap: ${record.bootstrapState}; files: ${record.workspaceFiles.length}; packages: ${record.packages.length}`,
      );
    }
  }
  if (target && status.records.length === 0) {
    runtime.exit(1);
  }
}

export { runClawsUpdateCommand } from "./claws-update-cli.runtime.js";

export async function runClawsRemoveCommand(
  target: string,
  opts: ClawsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (requireClawPlanConsent("remove", opts, runtime)) {
    return;
  }
  const selected = opts.removeReferenced ?? [];
  if (opts.removeUnused && selected.length > 0) {
    runtime.error("Choose either --remove-unused or --remove-referenced, not both.");
    runtime.exit(1);
    return;
  }
  if (opts.forceReferenced && selected.length === 0) {
    runtime.error("--force-referenced requires at least one --remove-referenced selector.");
    runtime.exit(1);
    return;
  }
  const referencedCleanup = selected.length
    ? {
        mode: "remove-selected" as const,
        selected,
        allowConflicts: Boolean(opts.forceReferenced),
      }
    : opts.removeUnused
      ? { mode: "remove-if-unused" as const }
      : { mode: "retain" as const };
  const plan = await buildClawRemovePlan(target, {
    referencedCleanup,
    monitorGateway: clawMonitorCleanupGateway,
  });
  if (opts.dryRun || plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      logClawRemovePlanSummary(plan, runtime);
      if (plan.blockers.length > 0) {
        runtime.error(plan.blockers.map((blocker) => blocker.message).join("\n"));
      }
    }
    if (plan.blockers.length > 0) {
      runtime.exit(1);
    }
    return;
  }
  try {
    const result = await applyClawRemovePlan(plan, {
      monitorGateway: clawMonitorCleanupGateway,
      packageGateway: clawPackageRemovalGateway,
      consentPlanIntegrity: opts.planIntegrity,
      referencedCleanup,
      cronGateway: {
        get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
        remove: async (id) => await callGatewayFromCli("cron.remove", {}, { id }),
      },
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`${result.agentRemoved ? "Removed agent" : "Agent"}: ${result.agentId}`);
      runtime.log(`Status: ${result.status}`);
      for (const pkg of result.packages) {
        runtime.log(
          `  Package ${pkg.kind}:${pkg.ref}@${pkg.version}: ${pkg.action}${pkg.reason ? ` (${pkg.reason})` : ""}`,
        );
      }
      runtime.log(`Package references released: ${result.packageRefsReleased}`);
      if (result.error) {
        runtime.error(result.error.message);
      }
      for (const warning of result.warnings ?? []) {
        runtime.log(`Warning: ${warning}`);
      }
      if (result.pluginRuntime) {
        runtime.log(
          `Plugin runtime changed in Gateway generation ${result.pluginRuntime.generation}.`,
        );
      }
    }
    if (result.status !== "complete") {
      runtime.exit(1);
    }
  } catch (error) {
    const code = error instanceof ClawRemoveError ? error.code : "remove_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}

export async function runClawsExportCommand(
  agentId: string,
  opts: ClawsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  try {
    const listedMcpServers = await listConfiguredMcpServers();
    if (!listedMcpServers.ok) {
      throw new ClawExportError("mcp_config_unavailable", listedMcpServers.error);
    }
    const result = await exportClawAgent(agentId, opts.out, {
      config: getRuntimeConfig(),
      sourceMcpServers: listedMcpServers.mcpServers,
      ...(opts.bootstrap ? { bootstrapPath: opts.bootstrap } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Exported agent: ${result.agentId}`);
    runtime.log(`Package directory: ${result.outputDirectory}`);
    runtime.log(
      `Workspace files: ${result.manifest.workspace.files.length + Object.keys(result.manifest.workspace.bootstrapFiles).length}`,
    );
    runtime.log(`Packages: ${result.manifest.packages.length}`);
    runtime.log(`Bootstrap: ${result.filesWritten.includes("BOOTSTRAP.md") ? "included" : "none"}`);
  } catch (error) {
    const code = error instanceof ClawExportError ? error.code : "export_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}
