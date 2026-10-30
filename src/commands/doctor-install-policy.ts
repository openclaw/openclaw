import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { probeInstallPolicy, validateInstallPolicyStatic } from "../security/install-policy.js";

type InstallPolicyHealthOptions = {
  deep?: boolean;
  env?: NodeJS.ProcessEnv;
  onFinding?: (finding: HealthFinding) => void;
};

async function collectInstallPolicyHealthLines(
  cfg: OpenClawConfig,
  options: InstallPolicyHealthOptions = {},
): Promise<string[]> {
  const validation = await validateInstallPolicyStatic(cfg);
  if (!validation.enabled) {
    return [];
  }

  const report = (message: string, severity: "warning" | "error", fixHint: string) => {
    const finding: HealthFinding = {
      checkId: "core/doctor/install-policy",
      severity,
      message,
      category: severity === "error" ? "fix-now" : "recommended",
      path: "security.installPolicy.exec",
      fixHint,
      docsUrl: "https://docs.openclaw.ai/gateway/security/tool-permissions#plugins",
    };
    if (options.onFinding) {
      options.onFinding(finding);
    } else {
      lines.push(`- ${severity.toUpperCase()}: ${message}`, `- ${fixHint}`);
    }
  };
  const repairHint =
    "Correct security.installPolicy.exec and its command permissions, then run openclaw doctor --deep. Covered installs and updates remain blocked until the policy check succeeds.";
  const lines: string[] = [
    `- Install policy enabled for: ${validation.targets.length > 0 ? validation.targets.join(", ") : "none"}`,
  ];
  for (const issue of validation.issues) {
    report(sanitizeTerminalText(issue.message), issue.severity, repairHint);
  }
  if (validation.issues.some((issue) => issue.severity === "error")) {
    if (!options.onFinding) {
      lines.push("- Installs and updates for covered targets will be blocked until this is fixed.");
    }
    return lines;
  }

  if (!options.deep) {
    lines.push(
      `- Static checks passed. Run ${formatCliCommand("openclaw doctor --deep")} to execute a synthetic policy check.`,
    );
    return lines;
  }

  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-install-policy-probe-"));
  try {
    const result = await probeInstallPolicy({
      config: cfg,
      env: options.env,
      logger: {},
      sourcePath: probeDir,
    });
    if (result?.warning) {
      report(
        `Deep check returned a warning: ${sanitizeTerminalText(result.warning.reason)}`,
        "warning",
        "No repair is needed if this is your intended policy. Review each real install warning; covered installs require explicit acknowledgement when this warning is returned. Doctor does not approve an install.",
      );
      return lines;
    }
    if (!result?.blocked) {
      lines.push("- Deep check allowed the synthetic install request.");
      return lines;
    }
    if (result.blocked.code === "security_scan_blocked") {
      lines.push(
        `- Deep check reached the policy command and the policy blocked the synthetic request: ${sanitizeTerminalText(result.blocked.reason)}`,
      );
      return lines;
    }
    report(
      `Deep check failed closed: ${sanitizeTerminalText(result.blocked.reason)}`,
      "error",
      repairHint,
    );
  } catch (err) {
    report(
      `Deep check could not run: ${sanitizeTerminalText(formatErrorMessage(err))}`,
      "error",
      repairHint,
    );
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true });
  }
  if (!options.onFinding) {
    lines.push("- Installs and updates for covered targets will be blocked until this is fixed.");
  }
  return lines;
}

export async function noteInstallPolicyHealth(
  cfg: OpenClawConfig,
  options: InstallPolicyHealthOptions = {},
): Promise<void> {
  const lines = await collectInstallPolicyHealthLines(cfg, options);
  if (lines.length === 0) {
    return;
  }
  note(lines.join("\n"), "Install policy");
}
