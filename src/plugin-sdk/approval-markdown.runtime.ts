/**
 * Runtime side of the approval markdown contract (RFC 0002).
 *
 * Kept separate from `approval-markdown.ts` because it imports the markdown
 * parser (`stripMarkdown`). Only the async send/forward path needs the
 * downgrade, so the parser must not reach the channel registry hot path that
 * imports the lightweight contract file.
 */
import { stripMarkdown } from "../shared/text/strip-markdown.js";

export type { ChannelApprovalTextMode } from "./approval-markdown.js";
export { DEFAULT_APPROVAL_TEXT_MODE } from "./approval-markdown.js";

/**
 * Project canonical approval markdown down to plaintext.
 *
 * Content-lossless, not byte-identical: the projection trims the message's
 * outer edges, so a prompt consisting of nothing but a fence would lose that
 * fence's surrounding whitespace. Fenced content in the body of a prompt — the
 * shape every approval builder emits, since the command fence is always
 * followed by the host and id block — survives exactly.
 *
 * Both options are pinned deliberately and must not become caller-configurable:
 *
 *  - `plain-text` mode, because the speech projection collapses repeated
 *    punctuation and punctuation-only lines, which would silently rewrite a
 *    pending shell command inside its own fence.
 *  - `label-and-url` links, because label-only projection hides a link's
 *    destination from the person being asked to approve it. That is a security
 *    property of an approval prompt, not a formatting preference.
 */
export function downgradeApprovalMarkdownToPlaintext(text: string): string {
  return stripMarkdown(text, { mode: "plain-text", linkStyle: "label-and-url" });
}
