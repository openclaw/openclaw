import type {
  DoctorHealthCheckContext,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceDir } from "./doctor-health-contribution-utils.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import { defineSplitHealthCheckInput } from "./health-check-adapter.js";
import type { DetectableHealthCheckInput } from "./health-check-runner-types.js";
import { isHealthCheckEnabledByDefault, type HealthFinding } from "./health-checks.js";

const loadHealthCheckRegistryModule = async () => await import("./health-check-registry.js");

function reportDoctorRepairResult(
  ctx: DoctorHealthFlowContext,
  result: Awaited<ReturnType<typeof import("./doctor-repair-flow.js").runDoctorHealthRepairs>>,
  findings: readonly HealthFinding[],
  note: typeof import("../../packages/terminal-core/src/note.js").note,
): void {
  ctx.cfg = result.config;
  renderStructuredHealthFindings(ctx, findings);
  recordDoctorHealthWarnings(ctx, findings, result.warnings);
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

function withDoctorHealthCheckFacts<T extends object>(
  ctx: DoctorHealthFlowContext,
  input: T,
): T & Pick<DoctorHealthCheckContext, "runWithPluginMetadataSnapshot"> {
  return {
    ...input,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  };
}

export async function runStructuredHealthRepairs(
  ctx: DoctorHealthFlowContext,
  resolveCoreChecks: () => Promise<readonly DetectableHealthCheckInput[]>,
): Promise<void> {
  if (!ctx.prompter.shouldRepair) {
    return;
  }
  const { registerBundledHealthChecks } = await import("./bundled-health-checks.js");
  const { listExtensionHealthChecksForDoctor } = await loadHealthCheckRegistryModule();
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");

  const workspaceDir = resolveDoctorWorkspaceDir(ctx.cfg, ctx.env);
  registerBundledHealthChecks({ cfg: ctx.cfg, cwd: workspaceDir, env: ctx.env });
  const checks = listExtensionHealthChecksForDoctor(await resolveCoreChecks())
    .filter(isHealthCheckEnabledByDefault)
    .map(defineSplitHealthCheckInput);
  const result = await runDoctorHealthRepairs(
    withDoctorHealthCheckFacts(ctx, {
      mode: "fix" as const,
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      env: ctx.env,
      cwd: workspaceDir,
      configPath: ctx.configPath,
    }),
    { checks },
  );
  reportDoctorRepairResult(ctx, result, result.remainingFindings, note);
}

export async function runCoreContributionHealth(
  ctx: DoctorHealthFlowContext,
  checkIds: readonly string[],
): Promise<void> {
  if (checkIds.length === 0) {
    return;
  }
  const { CORE_HEALTH_CHECKS } = await import("./doctor-core-checks.js");
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");

  const selectedIds = new Set(checkIds);
  const checks = CORE_HEALTH_CHECKS.filter((check) => selectedIds.has(check.id));
  if (checks.length === 0) {
    return;
  }
  const workspaceDir = resolveDoctorWorkspaceDir(ctx.cfg, ctx.env);
  const dryRun = !ctx.prompter.shouldRepair;
  const result = await runDoctorHealthRepairs(
    withDoctorHealthCheckFacts(ctx, {
      mode: "fix" as const,
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      cwd: workspaceDir,
      configPath: ctx.configPath,
      dryRun,
    }),
    { checks, dryRun },
  );
  reportDoctorRepairResult(ctx, result, dryRun ? result.findings : result.remainingFindings, note);
}

function formatHealthFindings(findings: readonly HealthFinding[]): string {
  return findings
    .map((finding) => {
      const lines = [`- ${finding.message}`];
      if (finding.path) {
        lines.push(`  path: ${finding.path}`);
      }
      if (finding.requirement) {
        lines.push(`  issue: ${finding.requirement}`);
      }
      if (finding.fixHint) {
        lines.push(`  fix: ${finding.fixHint}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export async function runCoreHealthFindingNote(
  ctx: DoctorHealthFlowContext,
  checkId: string,
): Promise<void> {
  const { CORE_HEALTH_CHECKS } = await import("./doctor-core-checks.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");

  const check = CORE_HEALTH_CHECKS.find((candidate) => candidate.id === checkId);
  if (!check) {
    return;
  }
  const findings = await check.detect(
    withDoctorHealthCheckFacts(ctx, {
      mode: "doctor" as const,
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      cwd: resolveDoctorWorkspaceDir(ctx.cfg, ctx.env),
      configPath: ctx.configPath,
      allowExecSecretRefs: ctx.options.allowExec === true,
    }),
  );
  if (findings.length === 0) {
    return;
  }
  recordDoctorHealthWarnings(ctx, findings);
  const information = findings.filter((finding) => finding.severity === "info");
  const warnings = findings.filter((finding) => finding.severity !== "info");
  if (information.length > 0) {
    note(formatHealthFindings(information), "Doctor information");
  }
  if (warnings.length > 0) {
    ctx.healthOk = false;
    note(formatHealthFindings(warnings), "Doctor warnings");
  }
}
