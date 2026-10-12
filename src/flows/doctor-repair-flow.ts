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

export async function runDoctorHealthRepairs(
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions = {},
): Promise<DoctorRepairRunResult> {
  const inputs = opts.checks ?? copyHealthChecks(listHealthChecks());
  const checks: readonly DoctorHealthCheck[] = inputs.map(normalizeHealthCheck);
  const findings: HealthFinding[] = [];
  const allRemainingFindings: HealthFinding[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const diffs: HealthRepairDiff[] = [];
  const effects: HealthRepairEffect[] = [];
  const outcome = {
    config: ctx.cfg,
    findings,
    remainingFindings: allRemainingFindings,
    changes,
    warnings,
    diffs,
    effects,
    checksRun: checks.length,
    checksRepaired: 0,
    checksValidated: 0,
  };

  for (const check of checks) {
    const checkContext = { ...ctx, cfg: outcome.config };
    let checkFindings: readonly HealthFinding[];
    try {
      checkFindings = await check.detect(checkContext);
    } catch (err) {
      outcome.warnings.push(`${check.id} detect failed: ${scrubDoctorErrorMessage(err)}`);
      continue;
    }
    outcome.findings.push(...checkFindings);
    if (checkFindings.length === 0 || check.repair === undefined) {
      outcome.remainingFindings.push(...checkFindings);
      continue;
    }

    let remainingFindings: readonly HealthFinding[] = [...checkFindings];
    // Split checks expose detect/repair separately, so repair output must be validated by detect().
    try {
      const result = await check.repair(
        { ...checkContext, dryRun: opts.dryRun === true, diff: opts.diff === true },
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
        continue;
      }
      if (result.config !== undefined && opts.dryRun !== true) {
        outcome.config = result.config;
      }
      outcome.checksRepaired++;
      if (opts.dryRun === true) {
        continue;
      }
      try {
        // Re-run only failing paths/ocPaths to avoid unrelated expensive checks.
        const validationFindings = await check.detect(
          { ...checkContext, cfg: outcome.config },
          {
            findings: remainingFindings,
            paths: uniqueDefined(remainingFindings.map((finding) => finding.path)),
            ocPaths: uniqueDefined(remainingFindings.map((finding) => finding.ocPath)),
          },
        );
        remainingFindings = validationFindings;
        outcome.checksValidated++;
        if (validationFindings.length > 0) {
          outcome.warnings.push(`${check.id} repair left ${validationFindings.length} finding(s)`);
        }
      } catch (err) {
        outcome.warnings.push(`${check.id} validation failed: ${scrubDoctorErrorMessage(err)}`);
      }
    } catch (err) {
      outcome.warnings.push(`${check.id} repair failed: ${scrubDoctorErrorMessage(err)}`);
    } finally {
      // Only completed validation replaces the original findings for this check.
      outcome.remainingFindings.push(...remainingFindings);
    }
  }

  return outcome;
}

function uniqueDefined(values: readonly (string | undefined)[]): readonly string[] {
  return uniqueStrings(values.filter((value): value is string => value !== undefined));
}
