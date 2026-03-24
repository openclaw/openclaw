import type { Command } from "commander";
import type { MigrateComponent } from "../../commands/migrate-shared.js";
import { ALL_MIGRATE_COMPONENTS } from "../../commands/migrate-shared.js";
import { migrateExportCommand, migrateImportCommand } from "../../commands/migrate.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

function parseComponents(value: string): MigrateComponent[] {
  const parts = value.split(",").map((s) => s.trim().toLowerCase());
  const valid: MigrateComponent[] = [];
  for (const part of parts) {
    if ((ALL_MIGRATE_COMPONENTS as readonly string[]).includes(part)) {
      valid.push(part as MigrateComponent);
    } else {
      throw new Error(
        `Unknown component "${part}". Valid components: ${ALL_MIGRATE_COMPONENTS.join(", ")}`,
      );
    }
  }
  return valid;
}

function parseAgents(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function registerMigrateCommand(program: Command) {
  const migrate = program
    .command("migrate")
    .description("Export and import OpenClaw state for cross-device migration")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/migrate", "docs.openclaw.ai/cli/migrate")}\n`,
    );

  migrate
    .command("export")
    .description(
      "Create a portable migration archive of config, credentials, sessions, and workspace",
    )
    .option("--output <path>", "Archive path or destination directory")
    .option(
      "--include <components>",
      `Components to include (comma-separated: ${ALL_MIGRATE_COMPONENTS.join(", ")})`,
    )
    .option("--agents <ids>", "Export only these agent IDs (comma-separated)")
    .option(
      "--strip-secrets",
      "Redact API keys and tokens from the JSON config file (credentials and sessions are not redacted)",
      false,
    )
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the export plan without writing the archive", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw migrate export", "Export everything to a timestamped archive."],
          [
            "openclaw migrate export --output ~/migration.tar.gz",
            "Write the archive to a specific path.",
          ],
          [
            "openclaw migrate export --include config,workspace",
            "Export only config and workspace files.",
          ],
          ["openclaw migrate export --agents main,research", "Export only specific agents."],
          ["openclaw migrate export --strip-secrets", "Export with API keys and tokens redacted."],
          ["openclaw migrate export --dry-run --json", "Preview the export plan in JSON format."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const components = opts.include ? parseComponents(opts.include as string) : undefined;
        const agents = opts.agents ? parseAgents(opts.agents as string) : undefined;
        await migrateExportCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          components,
          agents,
          stripSecrets: Boolean(opts.stripSecrets),
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });

  migrate
    .command("import <archive>")
    .description("Import a migration archive onto this machine")
    .option("--merge", "Deep-merge config into existing instead of overwriting", false)
    .option("--dry-run", "Preview what would be imported without writing any files", false)
    .option("--json", "Output JSON", false)
    .option("--remap-workspace <path>", "Override the target workspace directory on this machine")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw migrate import ./migration.tar.gz",
            "Import a migration archive, overwriting local state.",
          ],
          [
            "openclaw migrate import ./migration.tar.gz --merge",
            "Deep-merge imported config into existing config.",
          ],
          [
            "openclaw migrate import ./migration.tar.gz --dry-run",
            "Preview what would be imported without changing anything.",
          ],
          [
            "openclaw migrate import ./migration.tar.gz --remap-workspace ~/my-workspace",
            "Import workspace files to a custom directory.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateImportCommand(defaultRuntime, {
          archive: archive as string,
          merge: Boolean(opts.merge),
          dryRun: Boolean(opts.dryRun),
          json: Boolean(opts.json),
          remapWorkspace: opts.remapWorkspace as string | undefined,
        });
      });
    });
}
