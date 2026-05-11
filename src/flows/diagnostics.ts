import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export const DIAGNOSTIC_SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

export function parseDiagnosticSeverity(input: string | undefined): DiagnosticSeverity | null {
  if (input === "info" || input === "warning" || input === "error") {
    return input;
  }
  return null;
}

export function diagnosticMeetsSeverity(
  finding: Pick<DiagnosticFinding, "severity">,
  severityMin: DiagnosticSeverity,
): boolean {
  return DIAGNOSTIC_SEVERITY_RANK[finding.severity] >= DIAGNOSTIC_SEVERITY_RANK[severityMin];
}

export interface DiagnosticFinding {
  readonly checkId: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ocPath?: string;
  readonly fixHint?: string;
}

export type DiagnosticMode = "lint";

export interface DiagnosticContext {
  readonly mode: DiagnosticMode;
  readonly runtime: RuntimeEnv;
  readonly cfg: OpenClawConfig;
  readonly cwd?: string;
  readonly configPath?: string;
}

export interface DiagnosticCheck {
  readonly id: string;
  readonly kind: "core";
  readonly description: string;
  readonly source?: string;
  detect(ctx: DiagnosticContext): Promise<readonly DiagnosticFinding[]>;
}
