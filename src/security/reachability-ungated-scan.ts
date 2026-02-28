/**
 * Reachability-Bound Ungated Scan
 * Analyzes tool definitions to identify ungated irreversible primitives (including NODE_INVOKE)
 * that are tool-reachable without proper gating mechanisms.
 *
 * Pass condition: zero tool-reachable ungated irreversible primitives
 */

import type { SecurityAuditFinding } from "./audit.js";

export interface UngatedPrimitive {
  primitive: string;
  toolName: string;
  riskClass: string;
  isDenyByDefault: boolean;
  needsConfirmation: boolean;
  contractId: string;
}

export interface UngateScanResult {
  totalPrimitives: number;
  ungatePrimitives: UngatedPrimitive[];
  findings: SecurityAuditFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  passCondition: boolean;
}

// Irreversible primitive contracts that require strict gating
const IRREVERSIBLE_PRIMITIVES = [
  // NODE_INVOKE irreversible operations
  "NODE_EVAL_CODE",
  "NODE_CREATE_VM_CONTEXT",
  "NODE_NATIVE_ADDON",
  "NODE_MODIFY_PROCESS",
  // TOOL_DISPATCH_GATE irreversible operations
  "DISPATCH_DELETE",
  "DISPATCH_SHELL_EXEC",
  "DISPATCH_PRIVILEGED_ADMIN",
  "DISPATCH_SENSITIVE_DATA",
  // FILE_SYSTEM_OPS irreversible
  "FS_DELETE_FILE",
  "FS_DELETE_DIRECTORY",
  "FS_REMOVE_TREE",
  // SHELL_EXEC irreversible
  "SHELL_EXEC_PRIVILEGED",
  "SHELL_EXEC_SYSTEM",
  // CRON_SCHEDULE irreversible
  "CRON_DELETE_JOB",
  "CRON_DISABLE_JOB",
];

// Tools that have proper gating in place (deny_by_default or needs_confirmation)
const PROPERLY_GATED_CONTRACTS = new Set([
  "NODE_NATIVE_ADDON",
  "NODE_MODIFY_PROCESS",
  "NODE_EVAL_CODE",
  "NODE_CREATE_VM_CONTEXT",
  "DISPATCH_DELETE",
  "DISPATCH_SHELL_EXEC",
  "DISPATCH_PRIVILEGED_ADMIN",
  "DISPATCH_SENSITIVE_DATA",
]);

export function analyzeUngatedPrimitives(
  toolDefinitions: Array<{
    pack_id: string;
    contracts: Array<{
      contract_id: string;
      risk_class: string;
      deny_by_default?: boolean;
      needs_confirmation?: boolean;
    }>;
  }>,
): UngateScanResult {
  const findings: SecurityAuditFinding[] = [];
  const ungatePrimitives: UngatedPrimitive[] = [];
  const summary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const pack of toolDefinitions) {
    for (const contract of pack.contracts) {
      if (!IRREVERSIBLE_PRIMITIVES.includes(contract.contract_id)) {
        continue;
      }

      const isDenyByDefault = contract.deny_by_default === true;
      const needsConfirmation = contract.needs_confirmation === true;
      const isProperlyGated = isDenyByDefault || needsConfirmation;

      // Check if this is a NODE_INVOKE contract
      const isNodeInvoke = pack.pack_id === "openclawd.NODE_INVOKE";

      if (!isProperlyGated) {
        const primitive: UngatedPrimitive = {
          primitive: contract.contract_id,
          toolName: pack.pack_id,
          riskClass: contract.risk_class,
          isDenyByDefault,
          needsConfirmation,
          contractId: contract.contract_id,
        };

        ungatePrimitives.push(primitive);

        const severity =
          contract.risk_class === "CRITICAL"
            ? "critical"
            : contract.risk_class === "HIGH"
              ? "warn"
              : "info";

        const nodeInvokeNote = isNodeInvoke ? " (NODE_INVOKE)" : "";
        findings.push({
          checkId: `ungated.${pack.pack_id}.${contract.contract_id}`,
          severity: severity as "critical" | "warn" | "info",
          title: `Ungated irreversible primitive${nodeInvokeNote}: ${contract.contract_id}`,
          detail: `${contract.contract_id} in ${pack.pack_id} is reachable without gating. deny_by_default=${isDenyByDefault}, needs_confirmation=${needsConfirmation}.`,
          remediation: `Add gating: set deny_by_default=true or needs_confirmation=true for ${contract.contract_id}.`,
        });

        if (severity === "critical") {
          summary.critical++;
        } else if (severity === "warn") {
          summary.high++;
        } else {
          summary.low++;
        }
      }
    }
  }

  return {
    totalPrimitives: IRREVERSIBLE_PRIMITIVES.length,
    ungatePrimitives,
    findings,
    summary,
    passCondition: ungatePrimitives.length === 0,
  };
}

/**
 * Run the Reachability-Bound Ungated Scan
 * Returns results and enforces pass condition
 */
export async function runReachabilityUngateScan(
  toolDefinitions: Array<{
    pack_id: string;
    contracts: Array<{
      contract_id: string;
      risk_class: string;
      deny_by_default?: boolean;
      needs_confirmation?: boolean;
    }>;
  }>,
): Promise<UngateScanResult> {
  const result = analyzeUngatedPrimitives(toolDefinitions);
  return result;
}

/**
 * Format scan results for reporting
 */
export function formatUngateScanReport(result: UngateScanResult): string {
  const lines: string[] = [];

  lines.push("=".repeat(70));
  lines.push("REACHABILITY-BOUND UNGATED SCAN REPORT");
  lines.push("=".repeat(70));
  lines.push("");

  // Summary
  lines.push("FINDINGS SUMMARY:");
  lines.push(`  Critical: ${result.summary.critical}`);
  lines.push(`  High:     ${result.summary.high}`);
  lines.push(`  Medium:   ${result.summary.medium}`);
  lines.push(`  Low:      ${result.summary.low}`);
  lines.push(`  Total:    ${result.findings.length}`);
  lines.push("");

  // Pass/Fail
  lines.push(`PASS CONDITION: ${result.passCondition ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(
    `Tool-reachable ungated irreversible primitives: ${result.ungatePrimitives.length}`,
  );
  lines.push("");

  // NODE_INVOKE section if any findings
  const nodeInvokeFindings = result.findings.filter((f) =>
    f.checkId.includes("NODE_INVOKE"),
  );
  if (nodeInvokeFindings.length > 0) {
    lines.push("NODE_INVOKE FINDINGS:");
    for (const finding of nodeInvokeFindings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push(`    ${finding.detail}`);
      if (finding.remediation) {
        lines.push(`    Remediation: ${finding.remediation}`);
      }
    }
    lines.push("");
  }

  // All findings
  if (result.findings.length > 0) {
    lines.push("DETAILED FINDINGS:");
    for (const finding of result.findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push(`    ${finding.detail}`);
      if (finding.remediation) {
        lines.push(`    Remediation: ${finding.remediation}`);
      }
    }
  } else {
    lines.push("✅ No ungated irreversible primitives found");
  }

  lines.push("");
  lines.push("=".repeat(70));

  return lines.join("\n");
}
