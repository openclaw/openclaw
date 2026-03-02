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

  const hasDiscord = cfg.channels?.discord?.enabled === true;
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
    initial: true,
  });

  if (!shouldConfigure) {
    note(
      [
        "- Skipped System Owner configuration.",
        `  Configure later: ${formatCliCommand('openclaw config set commands.ownerAllowFrom \'["YOUR_DISCORD_ID"]\'')}`,
      ].join("\n"),
      "System Owner",
    );
    return { cfg, changed: false };
  }

  const discordUserId = await prompter.text({
    message: "Your Discord User ID (for System Owner privileges)",
    placeholder: "Right-click your profile → Copy User ID",
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) {
        return "Discord User ID is required";
      }
      if (!/^\d{17,20}$/.test(trimmed)) {
        return "Invalid Discord User ID (should be 17-20 digits)";
      }
      return undefined;
    },
  });

  if (!discordUserId || discordUserId.trim().length === 0) {
    note("- Skipped System Owner configuration (no ID provided)", "System Owner");
    return { cfg, changed: false };
  }

  const nextCfg: OpenClawConfig = {
    ...cfg,
    commands: {
      ...cfg.commands,
      ownerAllowFrom: [discordUserId.trim()],
    },
  };

  note(
    [
      `- System Owner configured: ${discordUserId.trim()}`,
      "  Only you can run privileged commands now.",
    ].join("\n"),
    "System Owner",
  );

  return { cfg: nextCfg, changed: true };
}
