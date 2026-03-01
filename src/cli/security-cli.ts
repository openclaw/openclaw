import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { runSecurityAudit } from "../security/audit.js";
import {
  loadConfigIntegrityStore,
  saveConfigIntegrityStore,
} from "../security/config-integrity-store.js";
import { updateFileIntegrityHash, verifyAllIntegrity } from "../security/config-integrity.js";
import { fixSecurityFootguns } from "../security/fix.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatHelpExamples } from "./help-format.js";

type SecurityAuditOptions = {
  json?: boolean;
  deep?: boolean;
  fix?: boolean;
};

function formatSummary(summary: { critical: number; warn: number; info: number }): string {
  const rich = isRich();
  const c = summary.critical;
  const w = summary.warn;
  const i = summary.info;
  const parts: string[] = [];
  parts.push(rich ? theme.error(`${c} critical`) : `${c} critical`);
  parts.push(rich ? theme.warn(`${w} warn`) : `${w} warn`);
  parts.push(rich ? theme.muted(`${i} info`) : `${i} info`);
  return parts.join(" · ");
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
          ["openclaw security audit --deep", "Include best-effort live Gateway probe checks."],
          ["openclaw security audit --fix", "Apply safe remediations and file-permission fixes."],
          ["openclaw security audit --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/security", "docs.openclaw.ai/cli/security")}\n`,
    );

  security
    .command("audit")
    .description("Audit config + local state for common security foot-guns")
    .option("--deep", "Attempt live Gateway probe (best-effort)", false)
    .option("--fix", "Apply safe fixes (tighten defaults + chmod state/config)", false)
    .option("--json", "Print JSON", false)
    .action(async (opts: SecurityAuditOptions) => {
      const fixResult = opts.fix ? await fixSecurityFootguns().catch((_err) => null) : null;

      const cfg = loadConfig();
      const report = await runSecurityAudit({
        config: cfg,
        deep: Boolean(opts.deep),
        includeFilesystem: true,
        includeChannelSecurity: true,
      });

      if (opts.json) {
        defaultRuntime.log(
          JSON.stringify(fixResult ? { fix: fixResult, report } : report, null, 2),
        );
        return;
      }

      const rich = isRich();
      const heading = (text: string) => (rich ? theme.heading(text) : text);
      const muted = (text: string) => (rich ? theme.muted(text) : text);

      const lines: string[] = [];
      lines.push(heading("OpenClaw security audit"));
      lines.push(muted(`Summary: ${formatSummary(report.summary)}`));
      lines.push(muted(`Run deeper: ${formatCliCommand("openclaw security audit --deep")}`));

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
            if (action.kind === "chmod") {
              const mode = action.mode.toString(8).padStart(3, "0");
              if (action.ok) {
                lines.push(muted(`  chmod ${mode} ${shortenHomePath(action.path)}`));
              } else if (action.skipped) {
                lines.push(
                  muted(`  skip chmod ${mode} ${shortenHomePath(action.path)} (${action.skipped})`),
                );
              } else if (action.error) {
                lines.push(
                  muted(`  chmod ${mode} ${shortenHomePath(action.path)} failed: ${action.error}`),
                );
              }
              continue;
            }
            const command = shortenHomeInString(action.command);
            if (action.ok) {
              lines.push(muted(`  ${command}`));
            } else if (action.skipped) {
              lines.push(muted(`  skip ${command} (${action.skipped})`));
            } else if (action.error) {
              lines.push(muted(`  ${command} failed: ${action.error}`));
            }
          }
          if (fixResult.errors.length > 0) {
            for (const err of fixResult.errors) {
              lines.push(muted(`  error: ${shortenHomeInString(err)}`));
            }
          }
        }
      }

      const bySeverity = (sev: "critical" | "warn" | "info") =>
        report.findings.filter((f) => f.severity === sev);

      const render = (sev: "critical" | "warn" | "info") => {
        const list = bySeverity(sev);
        if (list.length === 0) {
          return;
        }
        const label =
          sev === "critical"
            ? rich
              ? theme.error("CRITICAL")
              : "CRITICAL"
            : sev === "warn"
              ? rich
                ? theme.warn("WARN")
                : "WARN"
              : rich
                ? theme.muted("INFO")
                : "INFO";
        lines.push("");
        lines.push(heading(label));
        for (const f of list) {
          lines.push(`${theme.muted(f.checkId)} ${f.title}`);
          lines.push(`  ${f.detail}`);
          if (f.remediation?.trim()) {
            lines.push(`  ${muted(`Fix: ${f.remediation.trim()}`)}`);
          }
        }
      };

      render("critical");
      render("warn");
      render("info");

      defaultRuntime.log(lines.join("\n"));
    });

  registerIntegrityCli(security);
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function registerIntegrityCli(parent: Command) {
  const integrity = parent.command("integrity").description("Config integrity hash management");

  integrity
    .command("status")
    .description("Show hash status for all tracked files")
    .option("--json", "Print JSON", false)
    .action((opts: { json?: boolean }) => {
      const stateDir = resolveStateDir();
      const store = loadConfigIntegrityStore(stateDir);
      const results = verifyAllIntegrity(store, stateDir);

      if (opts.json) {
        const out: Record<string, unknown> = {};
        for (const [file, result] of results) {
          const entry = store.entries[file];
          out[file] = { ...result, updatedAt: entry?.updatedAt, updatedBy: entry?.updatedBy };
        }
        defaultRuntime.log(JSON.stringify(out, null, 2));
        return;
      }

      const rich = isRich();
      const heading = (t: string) => (rich ? theme.heading(t) : t);
      const muted = (t: string) => (rich ? theme.muted(t) : t);

      const lines: string[] = [];
      lines.push(heading("Config Integrity Status"));
      lines.push("");

      if (results.size === 0) {
        lines.push(muted("No tracked files found. Run the gateway to create initial baselines."));
        defaultRuntime.log(lines.join("\n"));
        return;
      }

      const maxFileLen = Math.max(...[...results.keys()].map((f) => f.length), 4);
      const fileCol = "File".padEnd(maxFileLen);
      lines.push(` ${fileCol}  Status          Last Updated`);
      lines.push(muted(" " + "─".repeat(maxFileLen + 40)));

      for (const [file, result] of results) {
        const entry = store.entries[file];
        const paddedFile = file.padEnd(maxFileLen);
        let statusStr: string;
        let timeStr: string;

        if (result.status === "ok") {
          statusStr = rich ? theme.success("✓ OK") : "OK";
          timeStr = entry ? `${formatRelativeTime(entry.updatedAt)} (${entry.updatedBy})` : "";
        } else if (result.status === "tampered") {
          statusStr = rich ? theme.error("✗ TAMPERED") : "TAMPERED";
          timeStr = entry ? `${formatRelativeTime(entry.updatedAt)} (${entry.updatedBy})` : "";
        } else if (result.status === "missing-baseline") {
          statusStr = rich ? theme.warn("⚠ No baseline") : "No baseline";
          timeStr = "";
        } else if (result.status === "file-not-found") {
          statusStr = muted("- Not found");
          timeStr = "";
        } else {
          statusStr = muted("? Error");
          timeStr = "";
        }

        lines.push(` ${paddedFile}  ${statusStr.padEnd(16)}${timeStr}`);
      }

      defaultRuntime.log(lines.join("\n"));
    });

  integrity
    .command("verify")
    .description("Verify all tracked files now")
    .option("--json", "Print JSON", false)
    .action((opts: { json?: boolean }) => {
      const stateDir = resolveStateDir();
      const store = loadConfigIntegrityStore(stateDir);
      const results = verifyAllIntegrity(store, stateDir);

      if (opts.json) {
        const out: Record<string, unknown> = {};
        for (const [file, result] of results) {
          out[file] = result;
        }
        defaultRuntime.log(JSON.stringify(out, null, 2));
        return;
      }

      const rich = isRich();
      let allOk = true;
      for (const [file, result] of results) {
        if (result.status === "ok") {
          defaultRuntime.log(`${rich ? theme.success("✓") : "OK"} ${file}`);
        } else if (result.status === "tampered") {
          allOk = false;
          defaultRuntime.log(
            `${rich ? theme.error("✗") : "FAIL"} ${file}: expected ${result.expectedHash}, got ${result.actualHash}`,
          );
        } else if (result.status === "missing-baseline") {
          defaultRuntime.log(`${rich ? theme.warn("⚠") : "WARN"} ${file}: no baseline`);
        } else if (result.status === "file-not-found") {
          defaultRuntime.log(`${rich ? theme.muted("-") : "-"} ${file}: file not found`);
        }
      }

      if (allOk && results.size > 0) {
        defaultRuntime.log(
          rich
            ? theme.success("\nAll files passed integrity check.")
            : "\nAll files passed integrity check.",
        );
      } else if (!allOk) {
        defaultRuntime.log(
          rich
            ? theme.error(
                '\nIntegrity violations detected. Run "openclaw security integrity update" after verifying changes.',
              )
            : '\nIntegrity violations detected. Run "openclaw security integrity update" after verifying changes.',
        );
      }
    });

  integrity
    .command("update")
    .description("Update hashes for all tracked files (after manual edit)")
    .action(() => {
      const stateDir = resolveStateDir();
      let store = loadConfigIntegrityStore(stateDir);
      const results = verifyAllIntegrity(store, stateDir);
      let count = 0;

      for (const [file] of results) {
        store = updateFileIntegrityHash(store, file, "manual", stateDir);
        count++;
      }

      saveConfigIntegrityStore(store, stateDir);
      defaultRuntime.log(`Updated integrity hashes for ${count} file(s).`);
    });

  integrity
    .command("audit-log")
    .description("Show recent integrity audit log entries")
    .option("--limit <n>", "Number of entries to show", "20")
    .option("--json", "Print JSON", false)
    .action((opts: { limit?: string; json?: boolean }) => {
      const stateDir = resolveStateDir();
      const store = loadConfigIntegrityStore(stateDir);
      const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
      const entries = store.auditLog.slice(-limit);

      if (opts.json) {
        defaultRuntime.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        defaultRuntime.log("No audit log entries.");
        return;
      }

      const rich = isRich();
      const muted = (t: string) => (rich ? theme.muted(t) : t);

      for (const entry of entries) {
        const ts = new Date(entry.ts).toISOString();
        const actionLabel =
          entry.action === "tampered"
            ? rich
              ? theme.error(entry.action)
              : entry.action
            : entry.action;
        defaultRuntime.log(
          `${muted(ts)} ${actionLabel.padEnd(14)} ${entry.file} ${muted(`(${entry.actor})`)}`,
        );
      }
    });
}
