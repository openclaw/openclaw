import { normalizeUpdatePostInstallDoctorWarnings } from "../infra/update-doctor-result.js";
import type {
  DoctorContributionHealthCheck,
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceDir } from "./doctor-health-contribution-utils.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type {
  HealthCheck,
  HealthFinding,
  HealthRepairContext,
  HealthRepairEffect,
} from "./health-checks.js";

export function legacyOwnedRepair(
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
  const declaredChecks = params.healthChecks;
  let healthChecks: readonly DoctorHealthCheck[] = [];
  if (declaredChecks !== undefined) {
    const checks = Array.isArray(declaredChecks) ? declaredChecks : [declaredChecks];
    const defaultId = id.startsWith("doctor:")
      ? `core/doctor/${id.slice("doctor:".length)}`
      : `core/doctor/${id}`;
    healthChecks = checks.map((check: DoctorContributionHealthCheck): DoctorHealthCheck => {
      const checkId = check.id ?? (checks.length === 1 ? defaultId : undefined);
      if (checkId === undefined) {
        throw new Error(
          `doctor contribution ${id} must specify health check ids when it declares multiple healthChecks`,
        );
      }
      return Object.assign({}, check, { id: checkId, kind: "core" as const, source: "doctor" });
    });
  }
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
      (async (ctx) => {
        const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
        const workspaceDir = resolveDoctorWorkspaceDir(ctx.cfg, ctx.env);
        const dryRun = !ctx.prompter.shouldRepair;
        const configBeforeRepair = JSON.stringify(ctx.cfg);
        const context: HealthRepairContext & DoctorHealthCheckContext = {
          mode: "fix",
          runtime: ctx.runtime,
          cfg: ctx.cfg,
          env: ctx.env,
          cwd: workspaceDir,
          configPath: ctx.configPath,
          dryRun,
          allowExecSecretRefs: ctx.options.allowExec === true,
          agentDatabaseRefusals: ctx.agentDatabaseRefusals,
        };
        const result = await runDoctorHealthRepairs(context, {
          checks: healthChecks,
          dryRun,
          progress: ctx.options.json !== true,
        });
        ctx.cfg = result.config;
        renderStructuredHealthFindings(ctx, result.findings);
        // Display retains original findings; finalization records only unresolved warnings.
        recordDoctorHealthWarnings(
          ctx,
          dryRun ? result.findings : result.remainingFindings,
          result.warnings,
        );
        for (const warning of result.warnings) {
          ctx.runtime.error(warning);
        }
        if (configBeforeRepair !== JSON.stringify(result.config)) {
          ctx.configResult.pendingChangePanels = [
            ...(ctx.configResult.pendingChangePanels ?? []),
            ...result.changes,
          ];
        } else {
          for (const change of result.changes) {
            ctx.runtime.log(change);
          }
        }
      }),
  };
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
