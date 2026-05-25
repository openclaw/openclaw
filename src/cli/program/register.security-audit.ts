import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerSecurityAuditCommand(program: Command) {
  program
    .command("security-audit")
    .description("Scan for leaked credentials, permission issues, and network exposure")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/security-audit", "docs.openclaw.ai/cli/security-audit")}\n`,
    )
    .option("--json", "Emit JSON findings instead of human-readable output", false)
    .option(
      "--severity-min <level>",
      "Drop findings below this severity (critical|high|medium|low)",
    )
    .option("--no-credentials", "Skip credential scanning", false)
    .option("--no-permissions", "Skip file permission audit", false)
    .option("--no-network", "Skip network exposure audit", false)
    .action(async (opts) => {
      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const { securityAuditCommand } = await import("../../commands/security-audit.js");
          const result = await securityAuditCommand(defaultRuntime, {
            json: Boolean(opts.json),
            severityMin:
              typeof opts.severityMin === "string"
                ? (opts.severityMin as "critical" | "high" | "medium" | "low").toUpperCase()
                : undefined,
            includeCredentials: opts.credentials !== false,
            includePermissions: opts.permissions !== false,
            includeNetwork: opts.network !== false,
          });

          // Exit with non-zero if CRITICAL findings exist
          if (result.summary.critical > 0) {
            defaultRuntime.exit(3);
            return;
          }
          if (result.summary.high > 0) {
            defaultRuntime.exit(2);
            return;
          }
          if (result.summary.total > 0) {
            defaultRuntime.exit(1);
            return;
          }
          defaultRuntime.exit(0);
        },
        (err) => {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(2);
        },
      );
    });
}
