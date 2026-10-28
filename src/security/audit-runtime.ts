import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatNodeSecurityWarning } from "../../node-version.mjs";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.types.js";

export function collectNodeRuntimeFindings(): SecurityAuditFinding[] {
  const nodeSecurityWarning = process.versions.bun
    ? null
    : formatNodeSecurityWarning(process.versions.node);
  if (nodeSecurityWarning) {
    return [
      {
        checkId: "runtime.node_security_patch",
        severity: "warn",
        title: "Audit process Node.js is below the recommended security patch level",
        detail: `Audit process runtime: ${nodeSecurityWarning}`,
        remediation:
          "Upgrade the Node.js runtime used to run this audit to the recommended security patch level or a newer supported release. The Gateway may use a different runtime; upgrade that runtime separately and restart the Gateway if needed.",
      },
    ];
  }
  return [];
}

export function collectElevatedFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const enabled = cfg.tools?.elevated?.enabled;
  const allowFrom = cfg.tools?.elevated?.allowFrom ?? {};

  if (enabled === false) {
    return findings;
  }
  for (const [provider, list] of Object.entries(allowFrom)) {
    const normalized = normalizeStringEntries(Array.isArray(list) ? list : []);
    if (normalized.includes("*")) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.wildcard`,
        severity: "critical",
        title: "Elevated exec allowlist contains wildcard",
        detail: `tools.elevated.allowFrom.${provider} includes "*" which effectively approves everyone on that channel for elevated mode.`,
      });
    } else if (normalized.length > 25) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.large`,
        severity: "warn",
        title: "Elevated exec allowlist is large",
        detail: `tools.elevated.allowFrom.${provider} has ${normalized.length} entries; consider tightening elevated access.`,
      });
    }
  }

  return findings;
}
