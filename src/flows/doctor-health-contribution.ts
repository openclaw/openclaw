import { normalizeUpdatePostInstallDoctorWarnings } from "../infra/update-doctor-result.js";
import type {
  DoctorContributionHealthCheck,
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceDir } from "./doctor-health-contribution-utils.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type { HealthFinding, HealthRepairContext } from "./health-checks.js";

type DoctorContributionOptions = {
  healthCheckIds?: readonly string[];
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
  required?: true;
  updateWork?: DoctorHealthContribution["updateWork"];
  run?: DoctorHealthContribution["run"];
};

export function createDoctorHealthContribution(
  id: string,
  label: string,
  options: DoctorContributionOptions | DoctorHealthContribution["run"],
): DoctorHealthContribution {
  const params: DoctorContributionOptions =
    typeof options === "function" ? { run: options } : options;
  const healthChecks = normalizeHealthChecks(id, params.healthChecks);
  const healthCheckIds = params.healthCheckIds ?? healthChecks.map((check) => check.id);
  if (params.run === undefined && healthChecks.length === 0) {
    throw new Error(`doctor contribution ${id} must define run or healthChecks`);
  }
  return {
    id,
    label,
    healthChecks,
    healthCheckIds,
    ...(params.required ? { required: true as const } : {}),
    ...(params.updateWork ? { updateWork: params.updateWork } : {}),
    run:
      params.run ??
      ((ctx) =>
        runStructuredDoctorHealthContribution({
          ctx,
          checks: healthChecks,
        })),
  };
}

function normalizeHealthChecks(
  contributionId: string,
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[],
): readonly DoctorHealthCheck[] {
  if (healthChecks === undefined) {
    return [];
  }
  const checks = Array.isArray(healthChecks) ? healthChecks : [healthChecks];
  const defaultId = contributionId.startsWith("doctor:")
    ? `core/doctor/${contributionId.slice("doctor:".length)}`
    : `core/doctor/${contributionId}`;
  return checks.map((check: DoctorContributionHealthCheck): DoctorHealthCheck => {
    const id = check.id ?? (checks.length === 1 ? defaultId : undefined);
    if (id === undefined) {
      throw new Error(
        `doctor contribution ${contributionId} must specify health check ids when it declares multiple healthChecks`,
      );
    }
    return Object.assign({}, check, { id, kind: "core" as const, source: "doctor" });
  });
}

async function runStructuredDoctorHealthContribution(params: {
  ctx: DoctorHealthFlowContext;
  checks: readonly DoctorHealthCheck[];
}): Promise<void> {
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const workspaceDir = resolveDoctorWorkspaceDir(params.ctx.cfg, params.ctx.env);
  const dryRun = !params.ctx.prompter.shouldRepair;
  const configBeforeRepair = JSON.stringify(params.ctx.cfg);
  const context: HealthRepairContext & DoctorHealthCheckContext = {
    mode: "fix",
    runtime: params.ctx.runtime,
    cfg: params.ctx.cfg,
    env: params.ctx.env,
    cwd: workspaceDir,
    configPath: params.ctx.configPath,
    dryRun,
    allowExecSecretRefs: params.ctx.options.allowExec === true,
    agentDatabaseRefusals: params.ctx.agentDatabaseRefusals,
  };
  const result = await runDoctorHealthRepairs(context, { checks: params.checks, dryRun });
  params.ctx.cfg = result.config;
  renderStructuredHealthFindings(params.ctx, result.findings);
  // Display retains original findings; finalization records only unresolved warnings.
  recordDoctorHealthWarnings(
    params.ctx,
    dryRun ? result.findings : result.remainingFindings,
    result.warnings,
  );
  for (const warning of result.warnings) {
    params.ctx.runtime.error(warning);
  }
  if (configBeforeRepair !== JSON.stringify(result.config)) {
    params.ctx.configResult.pendingChangePanels = [
      ...(params.ctx.configResult.pendingChangePanels ?? []),
      ...result.changes,
    ];
  } else {
    for (const change of result.changes) {
      params.ctx.runtime.log(change);
    }
  }
}

export function recordDoctorHealthWarnings(
  ctx: DoctorHealthFlowContext,
  findings: readonly HealthFinding[],
  warnings: readonly string[] = [],
  options?: { prepend?: boolean },
): void {
  const existing = ctx.updateWarnings ?? [];
  const added = [
    ...findings
      .filter((finding) => finding.severity === "warning")
      .map(
        (finding) =>
          `${finding.checkId}${finding.errorCode ? ` [${finding.errorCode}]` : ""}: ${finding.message}`,
      ),
    ...warnings,
  ];
  ctx.updateWarnings = normalizeUpdatePostInstallDoctorWarnings(
    options?.prepend ? [...added, ...existing] : [...existing, ...added],
  );
}

export function renderStructuredHealthFindings(
  ctx: DoctorHealthFlowContext,
  findings: readonly HealthFinding[],
): void {
  for (const finding of findings) {
    const write = finding.severity === "error" ? ctx.runtime.error : ctx.runtime.log;
    const where = finding.path !== undefined ? ` ${finding.path}` : "";
    const line = finding.line !== undefined ? `:${finding.line}` : "";
    write(`[${finding.severity}] ${finding.checkId}${where}${line} - ${finding.message}`);
    if (finding.fixHint !== undefined) {
      ctx.runtime.log(`  fix: ${finding.fixHint}`);
    }
  }
}
