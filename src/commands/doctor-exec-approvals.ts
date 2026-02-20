import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadExecApprovals } from "../infra/exec-approvals.js";
import { note } from "../terminal/note.js";

/**
 * Check for conflicting exec approval configurations between openclaw.json
 * and exec-approvals.json. Runs as part of `openclaw doctor`.
 *
 * This addresses the "two config surfaces" issue where users expect
 * `approvals.exec.enabled: false` to disable all approval behavior,
 * but exec-approvals.json has its own independent gating policy.
 *
 * See: https://github.com/openclaw/openclaw/issues/15047
 */
export function noteExecApprovalsWarnings(cfg: OpenClawConfig): void {
  const warnings: string[] = [];

  // Load exec-approvals.json (creates default if missing)
  const approvals = loadExecApprovals();
  const approvalsDefaults = approvals.defaults ?? {};

  // Load approvals.exec forwarding config from openclaw.json
  const approvalsExecForwarding = cfg.approvals?.exec ?? {};

  // Load tools.exec config from openclaw.json
  const toolsExec = cfg.tools?.exec ?? {};

  // =========================================
  // CHECK 1: approvals.exec.enabled=false but gating still active
  // =========================================
  // Users expect `approvals.exec.enabled: false` to disable all approval
  // behavior, but it only disables forwarding to chat channels.
  // The actual gating is controlled by exec-approvals.json.
  if (approvalsExecForwarding.enabled === false) {
    const effectiveSecurity = approvalsDefaults.security ?? "deny";
    const effectiveAsk = approvalsDefaults.ask ?? "on-miss";
    const gatingActive = effectiveSecurity !== "full" || effectiveAsk !== "off";

    if (gatingActive) {
      warnings.push(
        `- WARNING: approvals.exec.enabled=false but exec-approvals.json has active gating.`,
        `  Effective policy: security="${effectiveSecurity}", ask="${effectiveAsk}"`,
        `  Exec commands may still require approval and timeout without UI.`,
        ``,
        `  This happens because there are two config surfaces:`,
        `  - approvals.exec.enabled controls approval *forwarding* to chat channels`,
        `  - exec-approvals.json controls actual execution *gating*`,
        ``,
        `  Fix (to disable all exec approvals):`,
        `  - ${formatCliCommand("openclaw approvals set")} and set security="full", ask="off"`,
        `  - Or edit ~/.openclaw/exec-approvals.json directly`,
      );
    }
  }

  // =========================================
  // CHECK 2: tools.exec.security differs from exec-approvals.json
  // =========================================
  // When both are set but differ, exec-approvals.json takes precedence.
  // This can be confusing for users who only look at openclaw.json.
  const toolsSecurity = toolsExec.security;
  const approvalsSecurity = approvalsDefaults.security;
  if (toolsSecurity && approvalsSecurity && toolsSecurity !== approvalsSecurity) {
    warnings.push(
      `- INFO: tools.exec.security="${toolsSecurity}" differs from exec-approvals.json security="${approvalsSecurity}".`,
      `  exec-approvals.json takes precedence for actual gating.`,
      `  See: ${formatCliCommand("openclaw approvals get")} to view current policy.`,
    );
  }

  // =========================================
  // CHECK 3: tools.exec.ask differs from exec-approvals.json
  // =========================================
  const toolsAsk = toolsExec.ask;
  const approvalsAsk = approvalsDefaults.ask;
  if (toolsAsk && approvalsAsk && toolsAsk !== approvalsAsk) {
    warnings.push(
      `- INFO: tools.exec.ask="${toolsAsk}" differs from exec-approvals.json ask="${approvalsAsk}".`,
      `  exec-approvals.json takes precedence for actual gating.`,
      `  See: ${formatCliCommand("openclaw approvals get")} to view current policy.`,
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Exec Approvals");
  }
}
