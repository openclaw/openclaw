import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import { withDoctorProgress } from "./doctor-health-startup.js";
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
  readonly progress?: boolean;
}

interface DoctorRepairRunResult {
  readonly config: OpenClawConfig;
  readonly findings: readonly HealthFinding[];
  readonly remainingFindings: readonly HealthFinding[];
  readonly changes: readonly string[];
  readonly warnings: readonly string[];
  readonly diffs: readonly HealthRepairDiff[];
  readonly effects: readonly HealthRepairEffect[];
}

export async function runDoctorHealthRepairs(
  ctx: HealthRepairContext,
  opts: DoctorRepairRunOptions = {},
): Promise<DoctorRepairRunResult> {
  const checks = opts.checks ?? listHealthChecks();
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
  };

  for (const check of checks) {
    const phase = <T>(name: string, run: () => T | Promise<T>) =>
      withDoctorProgress(`${check.id}: ${name}`, run, opts.progress === true);
    const checkContext = { ...ctx, cfg: outcome.config };
    let checkFindings: readonly HealthFinding[];
    try {
      checkFindings = await phase("check", () => check.detect(checkContext));
    } catch (err) {
      const cause = scrubDoctorErrorMessage(err);
      outcome.warnings.push(`${check.id} detect failed: ${cause}`);
      const inspectionFailure: HealthFinding = {
        checkId: check.id,
        severity: "warning",
        category: "fix-now",
        message: `Doctor could not complete ${check.description}: ${cause}`,
        fixHint:
          "Inspect the reported cause and correct the failed prerequisite, then rerun openclaw doctor. This check has not established its health.",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/running#understanding-findings",
      };
      outcome.findings.push(inspectionFailure);
      outcome.remainingFindings.push(inspectionFailure);
      continue;
    }
    outcome.findings.push(...checkFindings);
    if (checkFindings.length === 0 || check.repair === undefined) {
      outcome.remainingFindings.push(...checkFindings);
      continue;
    }

    let remainingFindings = checkFindings;
    // Split checks expose detect/repair separately, so repair output must be validated by detect().
    try {
      const repair = check.repair.bind(check);
      const result = await phase("repair", () =>
        repair(
          { ...checkContext, dryRun: opts.dryRun === true, diff: opts.diff === true },
          checkFindings,
        ),
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
      if (opts.dryRun === true) {
        continue;
      }
      try {
        // Re-run only failing paths/ocPaths to avoid unrelated expensive checks.
        const validationFindings = await phase("validation", () =>
          check.detect(
            { ...checkContext, cfg: outcome.config },
            {
              findings: remainingFindings,
              paths: uniqueDefined(remainingFindings.map((finding) => finding.path)),
              ocPaths: uniqueDefined(remainingFindings.map((finding) => finding.ocPath)),
            },
          ),
        );
        remainingFindings = validationFindings;
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
