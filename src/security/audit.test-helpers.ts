import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { SecurityAuditOptions, SecurityAuditReport } from "./audit.js";
import { runSecurityAudit } from "./audit.js";

export const execDockerRawUnavailable: NonNullable<
  SecurityAuditOptions["execDockerRawFn"]
> = async () => {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("docker unavailable"),
    code: 1,
  };
};

export function successfulProbeResult(url: string) {
  return {
    ok: true,
    url,
    connectLatencyMs: 1,
    error: null,
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

export async function audit(
  config: SecurityAuditOptions["config"],
  extra?: Omit<SecurityAuditOptions, "config"> & { preserveExecApprovals?: boolean },
): Promise<SecurityAuditReport> {
  if (!extra?.preserveExecApprovals) {
    saveExecApprovals({ version: 1, agents: {} });
  }
  const { preserveExecApprovals: _preserveExecApprovals, ...options } = extra ?? {};
  return runSecurityAudit({
    config,
    includeFilesystem: false,
    includeChannelSecurity: false,
    ...options,
  });
}

export function hasFinding(res: SecurityAuditReport, checkId: string, severity?: string): boolean {
  return res.findings.some(
    (finding) => finding.checkId === checkId && (severity == null || finding.severity === severity),
  );
}
