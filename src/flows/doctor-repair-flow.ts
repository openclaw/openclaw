// Doctor repair flow builds and runs repair actions for doctor findings.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { copyHealthChecks, normalizeHealthCheck } from "./health-check-adapter.js";
import { listHealthChecks } from "./health-check-registry.js";
import type { DoctorHealthCheck } from "./health-check-runner-types.js";
import type {
  HealthFinding,
  HealthRepairContext,
  HealthRepairDiff,
  HealthRepairEffect,
} from "./health-checks.js";

// Repair runner for structured doctor health checks; carries config between checks.
interface DoctorRepairRunOptions {
  readonly checks?: readonly DoctorHealthCheck[];
  readonly dryRun?: boolean;
  readonly diff?: boolean;
}

interface DoctorRepairRunResult {
  readonly config: OpenClawConfig;
  readonly findings: readonly HealthFinding[];
  readonly remainingFindings: readonly HealthFinding[];
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
  readonly diffs: readonly HealthRepairDiff[];
  readonly effects: readonly HealthRepairEffect[];
  readonly checksRun: number;
  readonly checksRepaired: number;
  readonly checksValidated: number;
}

/** Runs health checks in fix mode, applies repair outputs, and validates repaired scopes. */
export async function runDoctorHealthRepairs(
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions = {},
): Promise<DoctorRepairRunResult> {
  const inputs = opts.checks ?? copyHealthChecks(listHealthChecks());
  const checks: readonly DoctorHealthCheck[] = inputs.map(normalizeHealthCheck);
  const result = createRepairRunResult(ctx.cfg, checks.length);

  for (const check of checks) {
    const runResult = await runHealthCheck(check, { ...ctx, cfg: result.config }, opts);
    result.config = runResult.config;
    result.findings.push(...runResult.findings);
    // Only a completed validation can replace this check's original findings;
    // skipped, failed, and unvalidated siblings must remain visible in mixed batches.
    result.remainingFindings.push(
      ...(runResult.checksValidated > 0 ? runResult.remainingFindings : runResult.findings),
    );
    result.changes.push(...runResult.changes);
    result.warnings.push(...runResult.warnings);
    result.diffs.push(...runResult.diffs);
    result.effects.push(...runResult.effects);
    result.checksRepaired += runResult.checksRepaired;
    result.checksValidated += runResult.checksValidated;
  }

  return result;
}

async function runHealthCheck(
  check: DoctorHealthCheck,
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions,
): Promise<DoctorRepairRunResult> {
  const outcome = createRepairRunResult(ctx.cfg, 1);

  let checkFindings: readonly HealthFinding[];
  try {
    checkFindings = await check.detect(ctx);
  } catch (err) {
    outcome.warnings.push(`${check.id} detect failed: ${scrubDoctorErrorMessage(err)}`);
    return outcome;
  }
  outcome.findings.push(...checkFindings);
  if (checkFindings.length === 0 || check.repair === undefined) {
    return outcome;
  }

  // Split checks expose detect/repair separately, so repair output must be validated by detect().
  try {
    const result = await check.repair(
      { ...ctx, dryRun: opts.dryRun === true, diff: opts.diff === true },
      checkFindings,
    );
    outcome.warnings.push(...(result.warnings ?? []));
    outcome.diffs.push(...(result.diffs ?? []));
    outcome.effects.push(...(result.effects ?? []));
    outcome.changes.push(...result.changes);
    const status = result.status ?? "repaired";
    if (status !== "repaired") {
      outcome.warnings.push(
        `${check.id} repair ${status}${result.reason ? `: ${result.reason}` : ""}`,
      );
      return outcome;
    }
    if (result.config !== undefined && opts.dryRun !== true) {
      outcome.config = result.config;
    }
    outcome.checksRepaired++;
    if (opts.dryRun === true) {
      return outcome;
    }
    try {
      const validationFindings = await check.detect(
        { ...ctx, cfg: outcome.config },
        createValidationScope(outcome.findings),
      );
      outcome.remainingFindings.push(...validationFindings);
      outcome.checksValidated++;
      if (validationFindings.length > 0) {
        outcome.warnings.push(`${check.id} repair left ${validationFindings.length} finding(s)`);
      }
    } catch (err) {
      outcome.warnings.push(`${check.id} validation failed: ${scrubDoctorErrorMessage(err)}`);
    }
  } catch (err) {
    outcome.warnings.push(`${check.id} repair failed: ${scrubDoctorErrorMessage(err)}`);
  }

  return outcome;
}

function createRepairRunResult(config: OpenClawConfig, checksRun: number) {
  const findings: HealthFinding[] = [];
  const remainingFindings: HealthFinding[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const diffs: HealthRepairDiff[] = [];
  const effects: HealthRepairEffect[] = [];
  return {
    config,
    findings,
    remainingFindings,
    changes,
    warnings,
    diffs,
    effects,
    checksRun,
    checksRepaired: 0,
    checksValidated: 0,
  };
}

// Re-run only the failing paths/ocPaths after repair to avoid unrelated expensive checks.
function createValidationScope(findings: readonly HealthFinding[]) {
  return {
    findings,
    paths: uniqueDefined(findings.map((finding) => finding.path)),
    ocPaths: uniqueDefined(findings.map((finding) => finding.ocPath)),
  };
}

function uniqueDefined(values: readonly (string | undefined)[]): readonly string[] {
  return uniqueStrings(values.filter((value): value is string => value !== undefined));
}
