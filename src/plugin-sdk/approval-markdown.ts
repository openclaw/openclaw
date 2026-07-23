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
 *
 * This file is the lightweight contract only — the mode type and its default.
 * It is imported by the channel registry (`approvals.ts`), which sits on hot
 * gateway/config/command startup paths, so it must stay free of heavy imports.
 * The downgrade implementation lives in `approval-markdown.runtime.ts` because
 * it pulls in the markdown parser and is only needed on the async send path.
 */

/** How a channel handles the canonical approval markdown subset. */
export type ChannelApprovalTextMode = "markdown" | "plaintext";

/**
 * Mode assumed when a channel declares nothing. Safe for every transport: it
 * never sends raw markers.
 *
 * This is an intentional opt-in default (RFC 0002), and it does change behavior
 * for an existing third-party channel that renders markdown but has not yet
 * declared `approvalText`: its forwarded approval text downgrades to plaintext
 * on upgrade until it opts in. That trade is deliberate — plaintext can only
 * ever lose rendering, never leak literal `**`/fences to an approver, which is
 * the failure mode that matters when the person is being asked to approve a
 * shell command. Channels that render markdown opt in explicitly.
 */
export const DEFAULT_APPROVAL_TEXT_MODE: ChannelApprovalTextMode = "plaintext";
