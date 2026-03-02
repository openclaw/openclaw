import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

/**
 * Prompts for System Owner Discord User ID if Discord is enabled but owner is not configured.
 * Returns updated config if changes were made.
 */
export async function maybePromptForSystemOwner(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  nonInteractive?: boolean;
}): Promise<{ cfg: OpenClawConfig; changed: boolean }> {
  const { cfg, prompter, nonInteractive } = params;

  const hasDiscord = cfg.channels?.discord?.enabled !== false;
  if (!hasDiscord) {
    return { cfg, changed: false };
  }

  const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
  const ownerConfigured = Array.isArray(ownerAllowFrom) && ownerAllowFrom.length > 0;

  if (ownerConfigured) {
    return { cfg, changed: false };
  }

  // System Owner not configured - prompt if interactive
  if (nonInteractive) {
    note(
      [
        "- Discord enabled but System Owner not configured.",
        `  Set manually: ${formatCliCommand('openclaw config set commands.ownerAllowFrom \'["YOUR_DISCORD_ID"]\'')}`,
        "  Get your Discord User ID: Enable Developer Mode → Right-click profile → Copy User ID",
      ].join("\n"),
      "System Owner",
    );
    return { cfg, changed: false };
  }

  const shouldConfigure = await prompter.confirm({
    message:
      "Discord is enabled but System Owner is not configured. Anyone can run privileged commands. Configure now?",
    initialValue: true,
  });

  if (!shouldConfigure) {
    note(
      [
        "- Skipped System Owner configuration.",
        `  Configure later: ${formatCliCommand('openclaw config set commands.ownerAllowFrom \'["YOUR_DISCORD_ID"]\'')}`,
        "  Get your Discord User ID: Enable Developer Mode → Right-click profile → Copy User ID",
      ].join("\n"),
      "System Owner",
    );
    return { cfg, changed: false };
  }

  // Guide user to configure System Owner manually via CLI
  // (DoctorPrompter does not support text input, so we provide instructions instead)
  note(
    [
      "To complete System Owner configuration:",
      "",
      "1. Get your Discord User ID:",
      "   - Enable Developer Mode in Discord (Settings → Advanced → Developer Mode)",
      "   - Right-click your profile → Copy User ID",
      "",
      "2. Configure System Owner:",
      `   ${formatCliCommand('openclaw config set commands.ownerAllowFrom \'["YOUR_DISCORD_ID"]\'')}`,
      "",
      "Example:",
      `   ${formatCliCommand('openclaw config set commands.ownerAllowFrom \'["119510072865980419"]\'')}`,
    ].join("\n"),
    "System Owner Setup",
  );

  return { cfg, changed: false };
}
