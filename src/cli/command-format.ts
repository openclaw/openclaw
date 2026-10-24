import { normalizeProfileName } from "./profile-utils.js";

const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const CONTAINER_FLAG_RE = /(?:^|\s)--container(?:\s|=|$)/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
// A flag value is one non-space token joined to its flag by `=` or whitespace.
// Keep the two spellings separate: a combined `[=\s]+` class lets the value
// matcher swallow the separator before the next ` --flag` chunk and consume that
// chunk instead, so repeated chunks admit many equivalent splits and matching
// degrades superlinearly. Neither branch below can cross whitespace, so each
// chunk boundary is forced and matching stays linear.
const UPDATE_RE =
  /^(?:\s+--(?:dev|no-color|(?:profile|log-level)(?:=\S+|\s+\S+)))*\s+update(?:\s|$)/;
const CONTAINER_HINT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const rawContainer = env.OPENCLAW_CONTAINER_HINT?.trim();
  const container = rawContainer && CONTAINER_HINT_RE.test(rawContainer) ? rawContainer : undefined;
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!container && !profile) {
    return command;
  }
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  let addition: string | undefined;
  if (
    container &&
    !CONTAINER_FLAG_RE.test(command) &&
    !UPDATE_RE.test(command.replace(CLI_PREFIX_RE, ""))
  ) {
    addition = `--container ${container}`;
  }
  if (!container && profile && !PROFILE_FLAG_RE.test(command) && !DEV_FLAG_RE.test(command)) {
    addition = `--profile ${profile}`;
  }
  return addition ? command.replace(CLI_PREFIX_RE, (match) => `${match} ${addition}`) : command;
}
