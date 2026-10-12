import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { POST_CORE_UPDATE_ENV } from "../infra/update-post-core-context.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { inheritOptionFromParent } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import { isJsonOutputModeActive } from "./json-output-mode.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { getProgramContext } from "./program/program-context.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";
import { UPDATE_OPTION_SPECS } from "./update-option-specs.js";
export type {
  UpdateCommandOptions,
  UpdateFinalizeOptions,
  UpdateStatusOptions,
  UpdateWizardOptions,
} from "./update-cli/shared.js";

function inheritedUpdateJson(command?: Command): boolean {
  return Boolean(inheritOptionFromParent<boolean>(command, "json"));
}

function handleUpdateCommandError(error: unknown): void {
  if (error instanceof ExitError || isJsonOutputModeActive(process.argv)) {
    throw error;
  }
  defaultRuntime.error(formatErrorMessage(error));
  defaultRuntime.exit(1);
}

function inheritedUpdateTimeout(
  opts: { timeout?: unknown; drainTimeout?: unknown },
  command?: Command,
  option: "timeout" | "drainTimeout" = "timeout",
): string | undefined {
  const timeout = opts[option] as string | undefined;
  return timeout !== undefined ? timeout : inheritOptionFromParent<string>(command, option);
}

type CommanderUpdateOptions = Record<string, unknown> &
  Omit<UpdateCommandOptions, "admission"> & { admission?: string };

function requiredUpdateLeafString(opts: Record<string, unknown>, key: string): string {
  const value = opts[key];
  if (typeof value !== "string") {
    throw new Error(
      `Missing required update option --${key.replaceAll(/[A-Z]/g, "-$&").toLowerCase()}`,
    );
  }
  return value;
}

// Leaves opt into dry-run explicitly; unsupported leaves reject it before owner work.
function createUpdateLeafAction(
  action: (opts: Record<string, unknown>, command: Command) => Promise<void>,
  options: { supportsDryRun?: boolean } = {},
) {
  return async (opts: Record<string, unknown>, command: Command) => {
    try {
      if (inheritOptionFromParent<boolean>(command, "reapplyLocalOverrides")) {
        throw new Error(
          `--reapply-local-overrides is not supported for openclaw update ${command.name()}. Use it with openclaw update.`,
        );
      }
      if (inheritOptionFromParent<string>(command, "sha") !== undefined) {
        throw new Error("--sha is supported only for openclaw update, not update subcommands.");
      }
      if (
        command.name() !== "recover" &&
        inheritOptionFromParent<string>(command, "drainTimeout") !== undefined
      ) {
        throw new Error(
          "--drain-timeout is supported only for immutable update and update recover.",
        );
      }
      if (!options.supportsDryRun && inheritOptionFromParent<boolean>(command, "dryRun")) {
        throw new Error(
          `--dry-run is not supported for \`openclaw update ${command.name()}\`. Run \`openclaw update --dry-run\` instead.`,
        );
      }
      await action(opts, command);
    } catch (err) {
      handleUpdateCommandError(err);
    }
  };
}

function registerUpdateFinalizationCommand(update: Command, name: string, hidden: boolean) {
  const command = update.command(name, { hidden });
  command
    .description("Reconcile abandoned updates or repair post-update doctor and plugin convergence")
    .option("--json", "Output result as JSON", false)
    .option("--channel <stable|extended-stable|beta|dev>", "Persist update channel before repair")
    .option("--timeout <seconds>", "Override per-phase repair deadlines in seconds")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .option("--accept-capabilities", "Accept widened plugin capabilities", false)
    .option("--no-restart", "Skip update activation; Doctor may restore a service it stops")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw update repair", "Reconcile abandoned runs or repair post-update state."],
          [
            "openclaw update repair --accept-capabilities",
            "Accept reviewed plugin capability changes during repair.",
          ],
          ["openclaw update repair --channel beta", "Repair against the beta update channel."],
          ["openclaw update repair --json", "JSON output for automation."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Reconciles abandoned runs when the Gateway is healthy; otherwise repairs post-update state",
        )}\n${theme.muted("- Runs Doctor repair and plugin convergence; repair restores only a service it stops")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(
      createUpdateLeafAction(async (opts, actionCommand) => {
        const repair = hidden
          ? (await import("./update-cli/update-command-finalize.js")).updateFinalizeCommand
          : (await import("./update-cli/update-repair-command.js")).updateRepairCommand;
        await repair({
          json: Boolean(opts.json) || inheritedUpdateJson(actionCommand),
          channel:
            (opts.channel as string | undefined) ??
            inheritOptionFromParent<string>(actionCommand, "channel"),
          timeout: inheritedUpdateTimeout(opts, actionCommand),
          yes: Boolean(opts.yes) || Boolean(inheritOptionFromParent<boolean>(actionCommand, "yes")),
          acceptCapabilities:
            Boolean(opts.acceptCapabilities) ||
            Boolean(inheritOptionFromParent<boolean>(actionCommand, "acceptCapabilities")),
          deferCompletionCache: hidden && process.env[POST_CORE_UPDATE_ENV]?.trim() === "1",
        });
      }),
    );
}

export function registerUpdateCli(program: Command) {
  program.enablePositionalOptions();
  const update = program
    .command("update")
    .description("Update OpenClaw and inspect update channel status");
  for (const [flags, description, defaultValue] of UPDATE_OPTION_SPECS) {
    update.option(flags, description, defaultValue);
  }
  update
    .addHelpText("after", () => {
      const examples = [
        ["openclaw update", "Update a source checkout (git)"],
        [
          "openclaw update --channel extended-stable",
          "Switch to the monthly supported npm channel",
        ],
        ["openclaw update --channel beta", "Switch to beta channel (git + npm)"],
        ["openclaw update --channel dev", "Switch to dev channel (git + npm)"],
        ["openclaw update --tag beta", "One-off update to a dist-tag or version"],
        ["openclaw update --dry-run", "Preview actions without changing anything"],
        ["openclaw update --no-restart", "Update without restarting the service"],
        ["openclaw update --json", "Output result as JSON"],
        ["openclaw update --yes", "Non-interactive (accept downgrade prompts)"],
        ["openclaw update --accept-capabilities", "Accept reviewed plugin capability changes"],
        ["openclaw update repair", "Repair stranded post-update plugin state"],
        ["openclaw update wizard", "Interactive update wizard"],
        ["openclaw --update", "Shorthand for openclaw update"],
      ] as const;
      const fmtExamples = formatHelpExamples(examples, true);
      return `
${theme.heading("What this does:")}
  - Git checkouts: fetches, rebases, installs deps, builds, and runs doctor
  - npm installs: updates via detected package manager
  - Adopted immutable installs: prepares sealed generations and activates only when adoption enables it

${theme.heading("Switch channels:")}
  - Use --channel stable|extended-stable|beta|dev to persist the update channel in config
  - Run openclaw update status to see the active channel and source
  - Use --tag <dist-tag|version|spec> for a one-off package update without persisting
  - Use --channel dev for the moving GitHub main checkout; package installs reject --tag main

${theme.heading("Non-interactive:")}
  - Use --yes to accept downgrade prompts
  - Use --accept-capabilities to accept each plugin's reviewed capability changes
  - Combine with --channel/--tag/--no-restart/--json/--timeout as needed
  - Use --dry-run to preview actions without writing config/installing/restarting

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Switch channels with --channel stable|extended-stable|beta|dev
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`;
    })
    .action(async (opts: CommanderUpdateOptions) => {
      try {
        if (
          opts.admission !== undefined &&
          opts.admission !== "auto" &&
          opts.admission !== "installed"
        ) {
          throw new Error('--admission must be "auto" or "installed".');
        }
        const { updateCommand } = await import("./update-cli/update-command.js");
        await updateCommand({
          runtimeRecoveryEnv: getProgramContext(program)?.runtimeRecoveryEnv,
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          reapplyLocalOverrides: Boolean(opts.reapplyLocalOverrides),
          dryRun: Boolean(opts.dryRun),
          channel: opts.channel,
          tag: opts.tag,
          sha: opts.sha,
          timeout: opts.timeout,
          drainTimeout: opts.drainTimeout,
          yes: Boolean(opts.yes),
          acceptCapabilities: Boolean(opts.acceptCapabilities),
          admission: opts.admission,
        });
      } catch (err) {
        handleUpdateCommandError(err);
      }
    });

  update
    .command("adopt-immutable")
    .description("Explicitly record ownership of an existing sealed release installation")
    .requiredOption("--root <path>", "Stable installation root containing current and releases")
    .requiredOption("--service <unit>", "Existing system-scope systemd service unit")
    .requiredOption("--account <name>", "Existing Gateway service account")
    .requiredOption("--state-dir <path>", "Existing Gateway state directory")
    .requiredOption("--config <path>", "Existing Gateway configuration file")
    .requiredOption("--runtime <path>", "Pinned external Node executable")
    .option("--profile <name>", "Existing Gateway profile")
    .option(
      "--enable-activation",
      "Enable native activation and recovery in the adoption record",
      false,
    )
    .option(
      "--inspect-release-retention",
      "Record inspect-only release retention after installing a compatible bridge",
      false,
    )
    .option(
      "--previous-updater-stopped",
      "Confirm the previous updater has settled and stopped scheduling",
      false,
    )
    .option("--json", "Output result as JSON", false)
    .action(
      createUpdateLeafAction(async (opts, command) => {
        if (opts.previousUpdaterStopped !== true) {
          throw new Error(
            "Adoption requires --previous-updater-stopped after the previous updater has settled and stopped scheduling.",
          );
        }
        for (const key of ["channel", "tag", "timeout", "restart", "acceptCapabilities", "yes"]) {
          const source = update.getOptionValueSource(key);
          if (source && source !== "default") {
            throw new Error(
              `The parent option ${key} is not supported for openclaw update adopt-immutable.`,
            );
          }
        }
        const { updateAdoptImmutableCommand } =
          await import("./update-cli/update-command-immutable.js");
        await updateAdoptImmutableCommand({
          root: requiredUpdateLeafString(opts, "root"),
          service: {
            unit: requiredUpdateLeafString(opts, "service"),
            scope: "system",
            account: requiredUpdateLeafString(opts, "account"),
            stateDir: requiredUpdateLeafString(opts, "stateDir"),
            configPath: requiredUpdateLeafString(opts, "config"),
            profile: typeof opts.profile === "string" ? opts.profile : null,
          },
          runtime: requiredUpdateLeafString(opts, "runtime"),
          previousUpdaterStopped: true,
          enableActivation: opts.enableActivation === true,
          inspectReleaseRetention: opts.inspectReleaseRetention === true,
          json: Boolean(opts.json) || inheritedUpdateJson(command),
        });
      }),
    );

  update
    .command("recover")
    .description("Resume a retained immutable activation without restarting a healthy Gateway")
    .requiredOption("--root <path>", "Stable adopted installation root")
    .option("--timeout <seconds>", "Bound readiness verification in seconds")
    .option(
      "--drain-timeout <seconds>",
      "Set the drain budget if recovery must stop an unhealthy service",
    )
    .option("--json", "Output result as JSON", false)
    .action(
      createUpdateLeafAction(async (opts, command) => {
        for (const key of ["channel", "tag", "restart", "acceptCapabilities", "yes"]) {
          const source = update.getOptionValueSource(key);
          if (source && source !== "default") {
            throw new Error(
              `The parent option ${key} is not supported for openclaw update recover.`,
            );
          }
        }
        const { updateRecoverImmutableCommand } =
          await import("./update-cli/update-command-immutable.js");
        await updateRecoverImmutableCommand({
          root: requiredUpdateLeafString(opts, "root"),
          timeout: inheritedUpdateTimeout(opts, command),
          drainTimeout: inheritedUpdateTimeout(opts, command, "drainTimeout"),
          json: Boolean(opts.json) || inheritedUpdateJson(command),
        });
      }),
    );

  setCommandJsonMode(update.command("admit", { hidden: true }), "output", () => true)
    .description("Internal read-only candidate admission protocol")
    .requiredOption("--context <path>", "Absolute path to the private admission context")
    .action(async (opts: { context: string }) => {
      const { updateAdmitCommand } = await import("./update-cli/update-command-admit.js");
      await updateAdmitCommand(opts.context);
    });

  update
    .command("cleanup")
    .description("Retire verified update recovery originals after acknowledging rollback loss")
    .option("--dry-run", "Inspect recovery metadata without writes", false)
    .option("--json", "Output one JSON result; never implies consent", false)
    .option("--yes", "Acknowledge permanent loss of the selected rollback originals", false)
    .action(
      createUpdateLeafAction(
        async (opts, command) => {
          for (const key of ["channel", "tag", "timeout", "restart", "acceptCapabilities"]) {
            if (
              update.getOptionValueSource(key) &&
              update.getOptionValueSource(key) !== "default"
            ) {
              throw new Error(
                `--${key === "restart" ? "no-restart" : key === "acceptCapabilities" ? "accept-capabilities" : key} is not supported for openclaw update cleanup.`,
              );
            }
          }
          const { updateCleanupCommand } = await import("./update-cli/cleanup.js");
          await updateCleanupCommand({
            dryRun:
              Boolean(opts.dryRun) || Boolean(inheritOptionFromParent<boolean>(command, "dryRun")),
            json: Boolean(opts.json) || inheritedUpdateJson(command),
            yes: Boolean(opts.yes) || Boolean(inheritOptionFromParent<boolean>(command, "yes")),
          });
        },
        { supportsDryRun: true },
      ),
    );

  registerUpdateFinalizationCommand(update, "repair", false);
  registerUpdateFinalizationCommand(update, "finalize", true);

  update
    .command("migration-plan", { hidden: true })
    .description("Plan Doctor-owned state migrations against an isolated snapshot")
    .requiredOption("--snapshot-home <path>", "Copied environment home")
    .requiredOption("--snapshot-config <path>", "Copied OpenClaw config")
    .requiredOption("--snapshot-state <path>", "Copied OpenClaw state directory")
    .option("--dry-run", "Accepted for parity; migration planning is always read-only", true)
    .option("--json", "Output result as JSON", true)
    .action(
      createUpdateLeafAction(
        async (opts) => {
          const { updateMigrationPlanCommand } =
            await import("./update-cli/update-command-migration-plan.js");
          await updateMigrationPlanCommand({
            snapshotConfig: requiredUpdateLeafString(opts, "snapshotConfig"),
            snapshotHome: requiredUpdateLeafString(opts, "snapshotHome"),
            snapshotState: requiredUpdateLeafString(opts, "snapshotState"),
          });
        },
        { supportsDryRun: true },
      ),
    );

  update
    .command("wizard")
    .description("Interactive update wizard")
    .option("--accept-capabilities", "Accept widened plugin capabilities", false)
    .option("--timeout <seconds>", "Set a per-step deadline in seconds")
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}\n`,
    )
    .action(
      createUpdateLeafAction(async (opts, command) => {
        const { updateWizardCommand } = await import("./update-cli/wizard.js");
        await updateWizardCommand({
          runtimeRecoveryEnv: getProgramContext(program)?.runtimeRecoveryEnv,
          timeout: inheritedUpdateTimeout(opts, command),
          acceptCapabilities:
            Boolean(opts.acceptCapabilities) ||
            Boolean(inheritOptionFromParent<boolean>(command, "acceptCapabilities")),
        });
      }),
    );

  update
    .command("status")
    .description("Show update channel and version status")
    .option("--json", "Output result as JSON", false)
    .option("--timeout <seconds>", "Timeout for update checks in seconds (default: 3)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw update status", "Show channel + version status."],
          ["openclaw update status --json", "JSON output."],
          ["openclaw update status --timeout 10", "Custom timeout."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Shows current update channel (stable/extended-stable/beta/dev) and source",
        )}\n${theme.muted("- Includes git tag/branch/SHA for source checkouts")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(
      createUpdateLeafAction(async (opts, command) => {
        const { updateStatusCommand } = await import("./update-cli/status.js");
        await updateStatusCommand({
          json: Boolean(opts.json) || inheritedUpdateJson(command),
          timeout: inheritedUpdateTimeout(opts, command),
        });
      }),
    );
}
