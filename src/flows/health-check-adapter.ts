import type {
  HealthCheck,
  HealthCheckRunResult,
  HealthCheckScope,
  HealthRepairContext,
  RegisteredHealthCheck,
  SplitHealthCheck,
} from "./health-checks.js";

export function defineSplitHealthCheck(check: SplitHealthCheck): RegisteredHealthCheck {
  return {
    id: check.id,
    kind: check.kind,
    description: check.description,
    source: check.source,
    detect: check.detect,
    repair: check.repair,
    async run(ctx, scope): Promise<HealthCheckRunResult> {
      const findings = await check.detect(ctx, scope);
      if (
        findings.length === 0 ||
        check.repair === undefined ||
        (!ctx.repair && ctx.previewRepair !== true)
      ) {
        return { findings };
      }
      const repairResult = await check.repair(
        {
          ...ctx,
          mode: "fix",
          dryRun: !ctx.repair,
          diff: ctx.diff === true,
        } as HealthRepairContext,
        findings,
      );
      return {
        findings,
        config: ctx.repair ? repairResult.config : undefined,
        changes: repairResult.changes,
        warnings: repairResult.warnings,
        diffs: repairResult.diffs,
        effects: repairResult.effects,
        status: ctx.repair ? repairResult.status : (repairResult.status ?? "repairable"),
        reason: repairResult.reason,
      };
    },
  };
}

export function normalizeHealthCheck(check: HealthCheck): RegisteredHealthCheck {
  return "run" in check ? check : defineSplitHealthCheck(check);
}
