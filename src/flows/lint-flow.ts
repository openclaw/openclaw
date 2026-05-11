import { listDiagnosticChecks } from "./diagnostic-registry.js";
import {
  DIAGNOSTIC_SEVERITY_RANK,
  diagnosticMeetsSeverity,
  type DiagnosticCheck,
  type DiagnosticContext,
  type DiagnosticFinding,
  type DiagnosticSeverity,
} from "./diagnostics.js";

export interface LintRunOptions {
  readonly checks?: readonly DiagnosticCheck[];
  readonly skipIds?: ReadonlySet<string> | readonly string[];
  readonly onlyIds?: ReadonlySet<string> | readonly string[];
}

export interface LintRunResult {
  readonly findings: readonly DiagnosticFinding[];
  readonly checksRun: number;
  readonly checksSkipped: number;
}

export async function runLintChecks(
  ctx: DiagnosticContext,
  opts: LintRunOptions = {},
): Promise<LintRunResult> {
  const all = opts.checks ?? listDiagnosticChecks();
  const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set(opts.skipIds ?? []);
  const only = opts.onlyIds instanceof Set ? opts.onlyIds : new Set(opts.onlyIds ?? []);

  const selected = all.filter((c) => {
    if (only.size > 0 && !only.has(c.id)) {
      return false;
    }
    if (skip.has(c.id)) {
      return false;
    }
    return true;
  });

  const findings: DiagnosticFinding[] = [];
  for (const check of selected) {
    try {
      const out = await check.detect(ctx);
      for (const f of out) {
        findings.push(f);
      }
    } catch (err) {
      findings.push({
        checkId: check.id,
        severity: "error",
        message: `diagnostic check threw: ${scrubErrorMessage(err)}`,
      });
    }
  }

  findings.sort(compareFindings);

  return {
    findings,
    checksRun: selected.length,
    checksSkipped: all.length - selected.length,
  };
}

function compareFindings(a: DiagnosticFinding, b: DiagnosticFinding): number {
  const sevDelta = DIAGNOSTIC_SEVERITY_RANK[b.severity] - DIAGNOSTIC_SEVERITY_RANK[a.severity];
  if (sevDelta !== 0) {
    return sevDelta;
  }
  const idDelta = a.checkId.localeCompare(b.checkId);
  if (idDelta !== 0) {
    return idDelta;
  }
  return (a.path ?? "").localeCompare(b.path ?? "");
}

const ERR_MESSAGE_MAX_LEN = 256;

function scrubErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let stripped = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code > 0x1f && code !== 0x7f) {
      stripped += raw.charAt(index);
    }
  }
  if (stripped.length <= ERR_MESSAGE_MAX_LEN) {
    return stripped;
  }
  return `${stripped.slice(0, ERR_MESSAGE_MAX_LEN - 3)}...`;
}

export function exitCodeFromFindings(
  findings: readonly DiagnosticFinding[],
  severityMin: DiagnosticSeverity = "warning",
): 0 | 1 {
  return findings.some((f) => diagnosticMeetsSeverity(f, severityMin)) ? 1 : 0;
}
