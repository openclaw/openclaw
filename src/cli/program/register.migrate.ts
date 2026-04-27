import type { Command } from "commander";
import { applyMigrationPlan } from "../../migrations/apply.js";
import { buildMigrationPlan } from "../../migrations/plan.js";
import { detectMigrationSources, listMigrationProviders } from "../../migrations/registry.js";
import { formatMigrationPlanText, redactMigrationPlan } from "../../migrations/report.js";
import type { MigrationProviderId } from "../../migrations/types.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

function parseProviderId(value: string | undefined): MigrationProviderId {
  return (value?.trim() || "hermes") as MigrationProviderId;
}

export function registerMigrateCommand(program: Command) {
  const migrate = program
    .command("migrate")
    .description("Detect, plan, and apply imports from other agent homes")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/migrate", "docs.openclaw.ai/cli/migrate")}\n`,
    );

  migrate
    .command("detect")
    .description("Detect importable agent homes")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const detections = await detectMigrationSources();
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(detections, null, 2));
          return;
        }
        if (detections.length === 0) {
          defaultRuntime.log("No importable agent homes detected.");
          return;
        }
        for (const detection of detections) {
          defaultRuntime.log(
            `${detection.label}: ${detection.sourceDir} (${detection.confidence}; ${detection.reasons.join(", ")})`,
          );
        }
      });
    });

  migrate
    .command("providers")
    .description("List available migration importers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const providers = listMigrationProviders().map((provider) => ({
          id: provider.id,
          label: provider.label,
        }));
        defaultRuntime.log(
          opts.json
            ? JSON.stringify(providers, null, 2)
            : providers.map((provider) => `${provider.id}\t${provider.label}`).join("\n"),
        );
      });
    });

  migrate
    .command("plan")
    .description("Build a dry-run migration plan")
    .requiredOption("--from <provider>", "Importer id, e.g. hermes")
    .option("--source <path>", "Source agent home")
    .option("--target-state <path>", "Target OpenClaw state dir")
    .option("--target-workspace <path>", "Target OpenClaw workspace dir")
    .option("--migrate-secrets", "Include opt-in secret migration actions", false)
    .option("--json", "Output redacted JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw migrate detect", "Find importable agent homes."],
          ["openclaw migrate plan --from hermes", "Preview a Hermes import."],
          [
            "openclaw migrate plan --from hermes --source ~/.hermes --json",
            "Print a redacted machine-readable plan.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const plan = await buildMigrationPlan({
          providerId: parseProviderId(opts.from),
          sourceDir: opts.source as string | undefined,
          targetStateDir: opts.targetState as string | undefined,
          targetWorkspaceDir: opts.targetWorkspace as string | undefined,
          migrateSecrets: Boolean(opts.migrateSecrets),
        });
        defaultRuntime.log(
          opts.json
            ? JSON.stringify(redactMigrationPlan(plan), null, 2)
            : formatMigrationPlanText(plan),
        );
      });
    });

  migrate
    .command("apply")
    .description("Apply a migration plan into a fresh OpenClaw setup")
    .requiredOption("--from <provider>", "Importer id, e.g. hermes")
    .option("--source <path>", "Source agent home")
    .option("--target-state <path>", "Target OpenClaw state dir")
    .option("--target-workspace <path>", "Target OpenClaw workspace dir")
    .option("--migrate-secrets", "Import recognized secrets into OpenClaw .env", false)
    .option("--dry-run", "Plan and report without writing imported state", false)
    .option("--yes", "Apply without an interactive confirmation", false)
    .option("--allow-existing", "Allow feature-gated import into existing OpenClaw state", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const allowExisting =
          Boolean(opts.allowExisting) && process.env.OPENCLAW_MIGRATION_EXISTING_IMPORT === "1";
        const plan = await buildMigrationPlan({
          providerId: parseProviderId(opts.from),
          sourceDir: opts.source as string | undefined,
          targetStateDir: opts.targetState as string | undefined,
          targetWorkspaceDir: opts.targetWorkspace as string | undefined,
          migrateSecrets: Boolean(opts.migrateSecrets),
        });
        if (!opts.dryRun && !opts.yes && process.stdout.isTTY) {
          defaultRuntime.error("Refusing to apply without --yes. Re-run with --dry-run or --yes.");
          defaultRuntime.exit(1);
          return;
        }
        const result = await applyMigrationPlan({
          plan,
          dryRun: Boolean(opts.dryRun),
          yes: Boolean(opts.yes),
          allowExisting,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(
          [
            `${opts.dryRun ? "Planned" : "Applied"} ${result.results.length} migration action${result.results.length === 1 ? "" : "s"}.`,
            `Report: ${result.reportDir}`,
          ].join("\n"),
        );
      });
    });
}
