import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { listHealthChecks } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding, HealthRepairContext } from "./health-checks.js";

export interface DoctorRepairRunOptions {
  readonly checks?: readonly HealthCheck[];
}

export interface DoctorRepairRunResult {
  readonly config: OpenClawConfig;
  readonly findings: readonly HealthFinding[];
  readonly remainingFindings: readonly HealthFinding[];
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
  readonly checksRun: number;
  readonly checksRepaired: number;
  readonly checksValidated: number;
}

export async function runDoctorHealthRepairs(
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions = {},
): Promise<DoctorRepairRunResult> {
  const checks = opts.checks ?? listHealthChecks();
  const findings: HealthFinding[] = [];
  const remainingFindings: HealthFinding[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  let cfg = ctx.cfg;
  let checksRepaired = 0;
  let checksValidated = 0;

  for (const check of checks) {
    const detectCtx: HealthRepairContext = { ...ctx, cfg };
    let checkFindings: readonly HealthFinding[];
    try {
      checkFindings = await check.detect(detectCtx);
    } catch (err) {
      warnings.push(`${check.id} detect failed: ${scrubDoctorErrorMessage(err)}`);
      continue;
    }
    findings.push(...checkFindings);
    if (checkFindings.length === 0 || check.repair === undefined) {
      continue;
    }

    try {
      const result = await check.repair({ ...ctx, cfg }, checkFindings);
      warnings.push(...(result.warnings ?? []));
      const status = result.status ?? "repaired";
      if (status !== "repaired") {
        warnings.push(`${check.id} repair ${status}${result.reason ? `: ${result.reason}` : ""}`);
        continue;
      }
      if (result.config !== undefined) {
        cfg = result.config;
      }
      changes.push(...result.changes);
      checksRepaired++;
      try {
        const validationFindings = await check.detect(
          { ...ctx, cfg },
          createValidationScope(checkFindings),
        );
        remainingFindings.push(...validationFindings);
        checksValidated++;
        if (validationFindings.length > 0) {
          warnings.push(`${check.id} repair left ${validationFindings.length} finding(s)`);
        }
      } catch (err) {
        warnings.push(`${check.id} validation failed: ${scrubDoctorErrorMessage(err)}`);
      }
    } catch (err) {
      warnings.push(`${check.id} repair failed: ${scrubDoctorErrorMessage(err)}`);
    }
  }

  return {
    config: cfg,
    findings,
    remainingFindings,
    changes,
    warnings,
    checksRun: checks.length,
    checksRepaired,
    checksValidated,
  };
}

function createValidationScope(findings: readonly HealthFinding[]) {
  return {
    findings,
    paths: uniqueDefined(findings.map((finding) => finding.path)),
    ocPaths: uniqueDefined(findings.map((finding) => finding.ocPath)),
  };
}

function uniqueDefined(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
