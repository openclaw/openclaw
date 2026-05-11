import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { registerDiagnosticCheck } from "./diagnostic-registry.js";
import type { DiagnosticCheck, DiagnosticFinding } from "./diagnostics.js";

const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/lint/final-config-validation";

export function configValidationIssuesToDiagnosticFindings(
  issues: readonly ConfigValidationIssue[],
): readonly DiagnosticFinding[] {
  return issues.map(
    (issue): DiagnosticFinding => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: "error",
      message: issue.message,
      path: issue.path || "<root>",
    }),
  );
}

const gatewayConfigCheck: DiagnosticCheck = {
  id: "core/lint/gateway-config",
  kind: "core",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  source: "core",
  async detect(ctx) {
    const findings: DiagnosticFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/lint/gateway-config",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/lint/gateway-config",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: DiagnosticCheck = {
  id: "core/lint/command-owner",
  kind: "core",
  description: "An owner account is configured for owner-only commands.",
  source: "core",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/lint/command-owner",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

const workspaceStatusCheck: DiagnosticCheck = {
  id: "core/lint/workspace-status",
  kind: "core",
  description: "Workspace directory exists and has no legacy duplicates.",
  source: "core",
  async detect(ctx) {
    const { detectLegacyWorkspaceDirs } = await import("../commands/doctor-workspace.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const legacy = detectLegacyWorkspaceDirs({ workspaceDir });
    if (legacy.legacyDirs.length === 0) {
      return [];
    }
    return [
      {
        checkId: "core/lint/workspace-status",
        severity: "info",
        message: `Detected ${legacy.legacyDirs.length} legacy workspace director${
          legacy.legacyDirs.length === 1 ? "y" : "ies"
        } alongside the active workspace.`,
        path: workspaceDir,
        fixHint:
          "Inspect the legacy directories and migrate or remove them; see `openclaw doctor` for the detailed migration prompt.",
      },
    ];
  },
};

const skillsReadinessCheck: DiagnosticCheck = {
  id: "core/lint/skills-readiness",
  kind: "core",
  description: "Allowed skills are usable in the current runtime environment.",
  source: "core",
  async detect(ctx) {
    return detectUnavailableSkills(ctx.cfg).map(unavailableSkillToFinding);
  },
};

function unavailableSkillToFinding(skill: SkillStatusEntry): DiagnosticFinding {
  return {
    checkId: "core/lint/skills-readiness",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

const finalConfigValidationCheck: DiagnosticCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "core",
  async detect() {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snap = await readConfigFileSnapshot();
    if (!snap.exists || snap.valid) {
      return [];
    }
    return configValidationIssuesToDiagnosticFindings(snap.issues);
  },
};

let registered = false;

export function registerCoreDiagnosticChecks(): void {
  if (registered) {
    return;
  }
  registerDiagnosticCheck(gatewayConfigCheck);
  registerDiagnosticCheck(commandOwnerCheck);
  registerDiagnosticCheck(workspaceStatusCheck);
  registerDiagnosticCheck(skillsReadinessCheck);
  registerDiagnosticCheck(finalConfigValidationCheck);
  registered = true;
}

export function resetCoreDiagnosticChecksForTest(): void {
  registered = false;
}

export const CORE_DIAGNOSTIC_CHECKS: readonly DiagnosticCheck[] = [
  gatewayConfigCheck,
  commandOwnerCheck,
  workspaceStatusCheck,
  skillsReadinessCheck,
  finalConfigValidationCheck,
];

function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

function formatMissingSkillSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}
