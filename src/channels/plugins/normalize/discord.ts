import { parseDiscordTarget } from "../../../discord/targets.js";

export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  // Don't default bare numeric IDs - let them throw ambiguity errors
  // to force users to use explicit prefixes (user: or channel:)
  const target = parseDiscordTarget(raw);
  return target?.normalized;
}

export function looksLikeDiscordTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@!?\d+>$/.test(trimmed)) {
    return true;
  }
  if (/^(user|channel|discord):/i.test(trimmed)) {
    return true;
  }
  // Bare numeric IDs (Discord snowflakes) are ambiguous - they could be user IDs or channel IDs.
  // Return false to force directory lookup, which will provide a helpful error message
  // asking the user to use explicit prefixes (user: or channel:).
  if (/^\d{6,}$/.test(trimmed)) {
    return false;
  }
  return false;
}
