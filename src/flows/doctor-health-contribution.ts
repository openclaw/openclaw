import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { normalizeUpdatePostInstallDoctorWarnings } from "../infra/update-doctor-result.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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

/** Repairs that only describe effects; the contribution's own run performs them. */
const legacyOwnedRepairs = new WeakSet<object>();

export function legacyOwnedRepair(
  collectEffects: (ctx: HealthRepairContext) => Promise<readonly HealthRepairEffect[]>,
  reason: string,
): NonNullable<HealthCheck["repair"]> {
  const repair: NonNullable<HealthCheck["repair"]> = async (ctx) => {
    const effects = await collectEffects(ctx);
    return ctx.dryRun === true
      ? { status: "repaired", changes: [], effects }
      : { status: "skipped", reason, changes: [], effects };
  };
  legacyOwnedRepairs.add(repair);
  return repair;
}

/**
 * Read-only: `runDoctorHealthRepairs` repairs a check only after its detect reports a
 * finding, so a run over these checks has work exactly when a check it can repair has one.
 * Checks without a repair, or whose repair only describes another owner's work, cannot write,
 * and a dry run writes nothing.
 */
export async function checkDoctorHealthRepairsPending(
  context: HealthRepairContext,
  checks: readonly DoctorHealthCheck[],
): Promise<DoctorMaintenancePending> {
  if (context.dryRun === true) {
    return "none";
  }
  for (const check of checks) {
    const ownRepair: unknown = Object.getOwnPropertyDescriptor(check, "repair")?.value;
    if (
      check.repair === undefined ||
      (typeof ownRepair === "function" && legacyOwnedRepairs.has(ownRepair))
    ) {
      continue;
    }
    if ((await check.detect(context)).length > 0) {
      return "work";
    }
  }
  return "none";
}

type DoctorContributionOptions = {
  healthCheckIds?: readonly string[];
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
  required?: true;
  updateWork?: DoctorHealthContribution["updateWork"];
  pending?: DoctorHealthContribution["pending"];
  run?: DoctorHealthContribution["run"];
};

/** Runs one core check's detect and repair; it has work exactly when that repair would run. */
export function coreHealthContribution(
  checkId: string,
): Pick<DoctorHealthContribution, "run" | "pending"> {
  return {
    async run(ctx) {
      const { runCoreContributionHealth } = await import("./doctor-health-contribution-core.js");
      await runCoreContributionHealth(ctx, [checkId]);
    },
    async pending(ctx) {
      const { checkCoreContributionRepairsPending } =
        await import("./doctor-health-contribution-core.js");
      return checkCoreContributionRepairsPending(ctx, [checkId]);
    },
  };
}

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
  const pending =
    params.pending ??
    (params.run === undefined
      ? (ctx: DoctorHealthFlowContext) =>
          checkDoctorHealthRepairsPending(createDefaultRunContext(ctx), healthChecks)
      : undefined);
  return {
    id,
    label,
    healthChecks,
    healthCheckIds,
    ...(params.required ? { required: true as const } : {}),
    ...(params.updateWork ? { updateWork: params.updateWork } : {}),
    ...(pending ? { pending } : {}),
    run:
      params.run ??
      (async (ctx) => {
        const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
        const dryRun = !ctx.prompter.shouldRepair;
        const configBeforeRepair = JSON.stringify(ctx.cfg);
        const context = createDefaultRunContext(ctx);
        const result = await runDoctorHealthRepairs(context, {
          checks: healthChecks,
          dryRun,
          progress: ctx.options.json !== true,
        });
        ctx.cfg = result.config;
        renderStructuredHealthFindings(ctx, dryRun ? result.findings : result.remainingFindings);
        // Repaired findings are absent from both the summary and updater warnings.
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

function createDefaultRunContext(
  ctx: DoctorHealthFlowContext,
): HealthRepairContext & DoctorHealthCheckContext {
  return {
    mode: "fix",
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    env: ctx.env,
    cwd: resolveDoctorWorkspaceDir(ctx.cfg, ctx.env),
    configPath: ctx.configPath,
    dryRun: !ctx.prompter.shouldRepair,
    allowExecSecretRefs: ctx.options.allowExec === true,
    agentDatabaseRefusals: ctx.agentDatabaseRefusals,
  };
}

export function recordDoctorHealthWarnings(
  ctx: Pick<DoctorHealthFlowContext, "updateWarnings">,
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

export function reportDoctorHealthFinding(
  ctx: Pick<DoctorHealthFlowContext, "runtime" | "healthFindings" | "updateWarnings">,
  finding: HealthFinding,
): void {
  recordDoctorHealthWarnings(
    ctx,
    [finding],
    finding.severity === "error" ? [`${finding.checkId}: ${finding.message}`] : [],
  );
  renderStructuredHealthFindings(ctx, [finding]);
}

export function renderStructuredHealthFindings(
  ctx: Pick<DoctorHealthFlowContext, "runtime" | "healthFindings">,
  findings: readonly HealthFinding[],
): void {
  ctx.healthFindings ??= [];
  ctx.healthFindings.push(...findings);
}

export function showDoctorHealthSummary(
  ctx: Pick<DoctorHealthFlowContext, "runtime" | "healthFindings">,
): void {
  const findings = ctx.healthFindings?.splice(0) ?? [];
  const log = createSubsystemLogger("doctor");
  for (const finding of findings) {
    // Debug console lines do not automatically print structured metadata.
    log.debug("Doctor finding", { ...finding, consoleMessage: JSON.stringify(finding) });
  }
  const selected = findings.filter(
    (finding) =>
      finding.severity === "error" ||
      (finding.severity === "warning" && (finding.category ?? "fix-now") === "fix-now"),
  );
  if (selected.length === 0) {
    return;
  }
  ctx.runtime.log("Fix now:");
  for (const finding of selected) {
    const write = finding.severity === "error" ? ctx.runtime.error : ctx.runtime.log;
    write(`- ${finding.message}`);
    if (finding.path !== undefined) {
      const line = finding.line !== undefined ? `:${finding.line}` : "";
      ctx.runtime.log(`  Location: ${finding.path}${line}`);
    }
    if (finding.fixHint !== undefined) {
      ctx.runtime.log(`  Next step: ${finding.fixHint}`);
    }
    ctx.runtime.log(
      `  Docs: ${finding.docsUrl ?? "https://docs.openclaw.ai/cli/doctor/running#understanding-findings"}`,
    );
  }
}

/** Preserve priority order in the updater receipt independently of summary rendering. */
export function collectDoctorHealthResultWarnings(params: {
  healthContext?: Pick<DoctorHealthFlowContext, "updateWarnings" | "updateBudget">;
  startupWarnings?: readonly string[];
  resultWarnings?: readonly string[];
  maintenanceWarnings?: readonly string[];
}): string[] {
  const contributionWarnings = [
    ...(params.healthContext?.updateWarnings ?? []),
    ...(params.startupWarnings ?? []),
  ];
  const deferredCount = params.healthContext?.updateBudget?.deferred.size ?? 0;
  return normalizeUpdatePostInstallDoctorWarnings([
    ...contributionWarnings.slice(0, deferredCount),
    ...(params.resultWarnings ?? []),
    ...(params.maintenanceWarnings ?? []).filter(
      (warning) => !params.resultWarnings?.includes(warning),
    ),
    ...contributionWarnings.slice(deferredCount),
  ]);
}

/** Startup repairs may report before the full health context exists. */
export function createDoctorHealthFindingBuffer(runtime: DoctorHealthFlowContext["runtime"]) {
  const buffer: Pick<DoctorHealthFlowContext, "runtime" | "healthFindings" | "updateWarnings"> & {
    healthFindings: HealthFinding[];
  } = { runtime, healthFindings: [] };
  return {
    buffer,
    reportFindings(this: void, findings: readonly HealthFinding[], warnings?: readonly string[]) {
      buffer.healthFindings.push(...findings);
      recordDoctorHealthWarnings(buffer, warnings ? [] : findings, warnings);
    },
  };
}
