/**
 * Canonical markdown contract for approval prompt text (RFC 0002).
 *
 * Core builds approval prompts once and every channel receives the same
 * string. That string is markdown, in a fixed subset:
 *
 *  - `**bold**`, `_italic_`, `~~strikethrough~~`
 *  - `` `inline code` ``
 *  - fenced code blocks, with an advisory language hint (`sh` for a pending
 *    command, `txt` for a plain block)
 *
 * Underline is excluded: most transports cannot express it, so core never
 * emits it. Language hints are advisory — a channel may honour one for native
 * highlighting and must drop an unsupported hint without altering the fenced
 * content.
 *
 * A channel either translates this subset into native styling or downgrades it
 * to plaintext, declared through `approvalText` on its approval capability.
 * There is no implicit pass-through: handing canonical markdown to a transport
 * that will not render it is how approvers end up reading literal backticks.
 */
import { stripMarkdown } from "../shared/text/strip-markdown.js";

/** How a channel handles the canonical approval markdown subset. */
export type ChannelApprovalTextMode = "markdown" | "plaintext";

/** Mode assumed when a channel declares nothing. Safe for every transport. */
export const DEFAULT_APPROVAL_TEXT_MODE: ChannelApprovalTextMode = "plaintext";

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
