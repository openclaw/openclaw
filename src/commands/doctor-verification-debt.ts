import type { OpenClawConfig } from "../config/config.js";
import type { DoctorCommandOptions } from "./doctor.js";
import { note } from "../terminal/note.js";
import { resolveDefaultAgentId } from "../config/agent-id.js";
import { resolveAgentWorkspaceDir } from "../config/paths.js";
import {
  loadVerificationDebt,
  calculateDebtScore,
  getDebtSummary,
} from "../security/verification-debt.js";

export async function noteVerificationDebt(
  cfg: OpenClawConfig,
  options: DoctorCommandOptions,
): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  
  try {
    const state = await loadVerificationDebt({ workspaceDir });
    const score = calculateDebtScore(state);
    const summary = getDebtSummary(state);
    
    if (summary.unresolved === 0) {
      note("✓ No verification debt — all security checks up to date.", "Security");
      return;
    }
    
    const lines: string[] = [];
    lines.push(`Verification Debt Score: ${score}`);
    lines.push("");
    lines.push(`Unresolved: ${summary.unresolved} / ${summary.total}`);
    lines.push("");
    
    if (summary.highRisk.length > 0) {
      lines.push("⚠️  High-risk items (score ≥7):");
      for (const item of summary.highRisk.slice(0, 5)) {
        const ageDays = Math.floor((Date.now() - item.skippedAt) / (24 * 60 * 60 * 1000));
        lines.push(`  - [${item.category}] ${item.description} (risk: ${item.riskScore}, ${ageDays}d)`);
      }
      if (summary.highRisk.length > 5) {
        lines.push(`  ... and ${summary.highRisk.length - 5} more`);
      }
      lines.push("");
    }
    
    lines.push("By category:");
    for (const [cat, count] of Object.entries(summary.byCategory)) {
      if (count > 0) {
        lines.push(`  - ${cat}: ${count}`);
      }
    }
    
    lines.push("");
    lines.push("Run 'openclaw security audit --deep' to address security debt.");
    
    const severity = score >= 20 ? "error" : score >= 10 ? "warn" : "info";
    note(lines.join("\n"), "Security", severity);
  } catch {
    // Debt file doesn't exist yet — that's fine, first run will create it
  }
}
