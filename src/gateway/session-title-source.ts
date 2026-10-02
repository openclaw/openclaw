/**
 * Removes channel addressing syntax from text that only feeds session titles.
 * Channel transcripts keep their exact bytes (e.g. Slack renders `<@U123> (bot)`);
 * titles describe the task, so addressee tokens and display-name annotations go.
 */

// Slack `<@U123>`/`<@U123|name>`, Discord `<@123>`/`<@!123>`/`<@&123>`, plus the
// `(display name)` annotation channel plugins append after a resolved mention.
const USER_MENTION = String.raw`<@[!&]?[A-Za-z0-9]+(?:\|[^>\n]*)?>(?:[ \t]*\([^()\n]{1,80}\))?`;
// Slack broadcast and user-group tokens such as `<!here>` or `<!subteam^S1|@team>`.
const BROADCAST_MENTION = String.raw`<![a-z]+(?:\^[A-Za-z0-9]+)?(?:\|[^>\n]*)?>`;
// Plain-text addressee at the very start (`@ohmybot, ...`); a trailing separator is required
// so package-like text such as `@types/node` stays intact.
const LEADING_HANDLE = String.raw`@[\p{L}\p{N}_.-]{1,64}(?=[\s,:;]|$)`;

const LEADING_ADDRESSING_RE = new RegExp(
  String.raw`^(?:\s*(?:${USER_MENTION}|${BROADCAST_MENTION}|${LEADING_HANDLE})[\s,:;\-–—]*)+`,
  "u",
);
const INLINE_MENTION_RE = new RegExp(`${USER_MENTION}|${BROADCAST_MENTION}`, "g");
const NAMED_MENTION_RE = /^<@[!&]?[A-Za-z0-9]+(?:\|([^>\n]*))?>(?:[ \t]*\(([^()\n]{1,80})\))?$/;

function renderInlineMention(token: string): string {
  // A mid-sentence mention can be part of the task ("ask @alice to review"), so keep
  // a readable name and drop only the transport id.
  const match = NAMED_MENTION_RE.exec(token);
  const name = (match?.[2] ?? match?.[1])?.trim().replace(/^@/, "");
  return name ? `@${name}` : "";
}

/** Strips leading addressees and transport mention ids from session-title source text. */
export function stripSessionTitleAddressing(text: string): string {
  return text
    .replace(LEADING_ADDRESSING_RE, "")
    .replace(INLINE_MENTION_RE, renderInlineMention)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
