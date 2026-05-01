import type { Command } from "commander";
import { profileExportCommand, profileImportCommand } from "../../commands/profile.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerProfileCommand(program: Command) {
  const profile = program
    .command("profile")
    .description("Export and import privacy-safe OpenClaw profile archives")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/profile", "docs.openclaw.ai/cli/profile")}\n`,
    );

  profile
    .command("export")
    .description("Write a profile archive for portable config, memory, and persona files")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the profile export plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw profile export", "Create a profile archive in the current directory."],
          [
            "openclaw profile export --output ~/Backups",
            "Write the profile archive into an existing backup directory.",
          ],
          [
            "openclaw profile export --dry-run --json",
            "Preview portable profile contents without writing an archive.",
          ],
          [
            "openclaw profile export --verify",
            "Create the archive and validate its manifest and payload layout.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await profileExportCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
        });
      });
    });

  profile
    .command("import")
    .description("Import a profile archive without overwriting local profile files")
    .argument("<archive>", "Profile archive path")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Preview import changes without writing files", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw profile import ./my.openclaw-profile.tar.gz",
            "Import portable profile config and memory into this machine.",
          ],
          [
            "openclaw profile import ./my.openclaw-profile.tar.gz --dry-run --json",
            "Preview imported fields and skipped local files.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await profileImportCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
        });
      });
    });
}
