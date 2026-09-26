// Security CLI for local/deep audits and safe remediation.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import type { GatewayAuthMode } from "../config/types.gateway.js";
import { defaultRuntime } from "../runtime.js";
import { runSecurityAuditCore } from "../security/audit.js";
import { fixSecurityFootguns } from "../security/fix.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { getSecurityAuditCommandSecretTargetIds } from "./command-secret-targets.js";
import { formatDocsHelp, formatHelpExamples } from "./help-format.js";

type SecurityAuditOptions = {
  json?: boolean;
  deep?: boolean;
  fix?: boolean;
  auth?: string;
  token?: string;
  password?: string;
};

function parseGatewayAuthMode(value: string | undefined): GatewayAuthMode | undefined {
  const mode = normalizeOptionalLowercaseString(value);
  if (!mode) {
    return undefined;
  }
  if (mode === "none" || mode === "token" || mode === "password" || mode === "trusted-proxy") {
    return mode;
  }
  throw new Error(
    'Invalid --auth value. Expected "none", "token", "password", or "trusted-proxy".',
  );
}

function buildAuditGatewayAuthOverride(params: {
  mode?: GatewayAuthMode;
  token?: string;
  password?: string;
}) {
  // Explicit runtime auth overrides must include the matching credential.
  if (!params.mode) {
    return undefined;
  }
  if (params.mode === "token" && !params.token) {
    throw new Error("Invalid --auth token: pass --token <token> for audit auth override.");
  }
  if (params.mode === "password" && !params.password) {
    throw new Error("Invalid --auth password: pass --password <password> for audit auth override.");
  }
  return {
    mode: params.mode,
    ...(params.token ? { token: params.token } : {}),
    ...(params.password ? { password: params.password } : {}),
  };
}

function formatSummary(summary: { critical: number; warn: number; info: number }): string {
  const rich = isRich();
  return [
    colorize(rich, theme.error, `${summary.critical} critical`),
    colorize(rich, theme.warn, `${summary.warn} warn`),
    colorize(rich, theme.muted, `${summary.info} info`),
  ].join(" · ");
}

export function registerSecurityCli(program: Command) {
  const security = program
    .command("security")
    .description("Audit local config and state for common security foot-guns")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw security audit", "Run a local security audit."],
          [
            "openclaw security audit --deep",
            "Include best-effort live Gateway probes and plugin-owned security audit collectors.",
          ],
          ["openclaw security audit --deep --token <token>", "Use explicit token for deep probe."],
          [
            "openclaw security audit --deep --password <password>",
            "Use explicit password for deep probe.",
          ],
          [
            "openclaw security audit --auth password --password <password>",
            "Audit a runtime-only password-mode Gateway secret.",
          ],
          ["openclaw security audit --fix", "Apply safe remediations and file-permission fixes."],
          ["openclaw security audit --json", "Output machine-readable JSON."],
        ])}\n${formatDocsHelp("/cli/security")}`,
    );

  security
    .command("audit")
    .description("Audit config + local state for common security foot-guns")
    .option("--deep", "Attempt live Gateway probes and plugin-owned collector checks", false)
    .option(
      "--auth <mode>",
      'Runtime gateway auth mode ("none"|"token"|"password"|"trusted-proxy")',
    )
    .option("--token <token>", "Use explicit gateway token for deep probe auth")
    .option("--password <password>", "Use explicit gateway password for deep probe auth")
    .option("--fix", "Apply safe fixes (tighten defaults + chmod state/config)", false)
    .option("--json", "Print JSON", false)
    .action(async (opts: SecurityAuditOptions) => {
      const authMode = parseGatewayAuthMode(opts.auth);
      const token = normalizeOptionalString(opts.token);
      const password = normalizeOptionalString(opts.password);
      const auditGatewayAuthOverride = buildAuditGatewayAuthOverride({
        mode: authMode,
        token,
        password,
      });
      const fixResult = opts.fix
        ? await fixSecurityFootguns().catch((_err: unknown) => null)
        : null;

      const sourceConfig = getRuntimeConfig();
      const { resolvedConfig: cfg, diagnostics: secretDiagnostics } =
        await resolveCommandSecretRefsViaGateway({
          config: sourceConfig,
          commandName: "security audit",
          targetIds: getSecurityAuditCommandSecretTargetIds(),
          mode: "read_only_status",
        });
      const report = await runSecurityAuditCore({
        config: cfg,
        sourceConfig,
        deep: Boolean(opts.deep),
        includeFilesystem: true,
        includeChannelSecurity: true,
        deepProbeAuth:
          token || password
            ? {
                ...(token ? { token } : {}),
                ...(password ? { password } : {}),
              }
            : undefined,
        auditGatewayAuthOverride,
      });

      if (opts.json) {
        defaultRuntime.writeJson(
          fixResult
            ? { fix: fixResult, report, secretDiagnostics }
            : { ...report, secretDiagnostics },
        );
        return;
      }

      const rich = isRich();
      const heading = (text: string) => (rich ? theme.heading(text) : text);
      const muted = (text: string) => (rich ? theme.muted(text) : text);

      const lines: string[] = [];
      lines.push(heading("OpenClaw security audit"));
      lines.push(muted(`Summary: ${formatSummary(report.summary)}`));
      if ((report.suppressedFindings?.length ?? 0) > 0) {
        lines.push(muted(`Suppressed: ${report.suppressedFindings?.length ?? 0} configured`));
      }
      lines.push(muted(`Run deeper: ${formatCliCommand("openclaw security audit --deep")}`));
      for (const diagnostic of secretDiagnostics) {
        lines.push(muted(`[secrets] ${diagnostic}`));
      }

      if (opts.fix) {
        lines.push(muted(`Fix: ${formatCliCommand("openclaw security audit --fix")}`));
        if (!fixResult) {
          lines.push(muted("Fixes: failed to apply (unexpected error)"));
        } else if (
          fixResult.errors.length === 0 &&
          fixResult.changes.length === 0 &&
          fixResult.actions.every((a) => !a.ok)
        ) {
          lines.push(muted("Fixes: no changes applied"));
        } else {
          lines.push("");
          lines.push(heading("FIX"));
          for (const change of fixResult.changes) {
            lines.push(muted(`  ${shortenHomeInString(change)}`));
          }
          for (const action of fixResult.actions) {
            const command =
              action.kind === "chmod"
                ? `chmod ${action.mode.toString(8).padStart(3, "0")} ${shortenHomePath(action.path)}`
                : shortenHomeInString(action.command);
            if (action.ok) {
              lines.push(muted(`  ${command}`));
            } else if (action.skipped) {
              lines.push(muted(`  skip ${command} (${action.skipped})`));
            } else if (action.error) {
              lines.push(muted(`  ${command} failed: ${action.error}`));
            }
          }
          for (const err of fixResult.errors) {
            lines.push(muted(`  error: ${shortenHomeInString(err)}`));
          }
        }
      }

      for (const [severity, style] of [
        ["critical", theme.error],
        ["warn", theme.warn],
        ["info", theme.muted],
      ] as const) {
        const list = report.findings.filter((finding) => finding.severity === severity);
        if (list.length === 0) {
          continue;
        }
        const label = colorize(rich, style, severity.toUpperCase());
        lines.push("");
        lines.push(heading(label));
        for (const f of list) {
          lines.push(`${theme.muted(f.checkId)} ${f.title}`);
          lines.push(`  ${f.detail}`);
          if (f.remediation?.trim()) {
            lines.push(`  ${muted(`Fix: ${f.remediation.trim()}`)}`);
          }
        }
      }

      defaultRuntime.log(lines.join("\n"));
    });
}
