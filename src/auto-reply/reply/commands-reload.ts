import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handles `/reload` — forces a refresh of skills, extensions, and templates.
 *
 * Bumps the skills snapshot version so the next agent run rebuilds the skills
 * prompt from disk. Template caches are filesystem-based (no persistent cache)
 * so they are already fresh on every read.
 */
export const handleReloadCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();
  if (body !== "/reload") {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reload from unauthorized sender: ${params.command.senderId ?? "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Bump the skills snapshot version — next message will rebuild the skills prompt from disk
  bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir });

  logVerbose(`/reload: bumped skills snapshot version for workspace: ${params.workspaceDir}`);

  return {
    shouldContinue: false,
    reply: {
      text: [
        "♻️ **Reload triggered.**",
        "",
        "• Skills snapshot invalidated — will reload from disk on next message",
        "• Templates are read fresh from `~/.openclaw/templates/` on every use",
        "• Extensions/plugins are reloaded on next agent run",
      ].join("\n"),
    },
  };
};
