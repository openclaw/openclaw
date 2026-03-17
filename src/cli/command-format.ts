import { replaceCliName, resolveCliName } from "./cli-name.js";
import { normalizeProfileName } from "./profile-utils.js";

// Matches any openclaw invocation prefix: bare `openclaw` or via pnpm/npm/bunx/npx wrappers.
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
// Matches an existing --profile flag so we do not inject a duplicate.
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
// Matches an existing --dev flag, which already implies a non-default profile context.
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;

/**
 * Rewrites `command` to use the active CLI name and injects `--profile <name>`
 * when OPENCLAW_PROFILE is set and the command does not already include --profile or --dev.
 */
export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const cliName = resolveCliName();
  const normalizedCommand = replaceCliName(command, cliName);
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!profile) {
    return normalizedCommand;
  }
  if (!CLI_PREFIX_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) {
    return normalizedCommand;
  }
  return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}
