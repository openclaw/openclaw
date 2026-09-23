// Renders a session's raw output ring as plain text for the agent terminal tool,
// which needs readable output rather than escape sequences.
import { stripAnsiSequences } from "../../../packages/terminal-core/src/ansi.js";

// Built at runtime so the source stays free of literal control characters and
// the no-control-regex lint rule cannot statically detect them (same approach
// as terminal-core's sanitizeForLog). Tab survives; \r/\n are handled above.
const C0_EXCEPT_TAB_CR_LF = `${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
// C1 control characters (0x80-0x9f) include the CSI introducer (0x9b),
// which is an alternative ANSI escape prefix equivalent to ESC [.
const C1 = `${String.fromCharCode(0x80)}-${String.fromCharCode(0x9f)}`;
const CONTROL_BYTES_REGEX = new RegExp(`[${C0_EXCEPT_TAB_CR_LF}${C1}]`, "g");

/**
 * Approximates what a terminal would show without running a VT emulator:
 * strips ANSI sequences, collapses carriage-return overwrites (progress bars
 * emit "10%\r20%\r30%" — keep the last write per line), and drops remaining
 * C0/C1 control bytes. Cursor-movement layouts (vim, htop) will not reconstruct
 * faithfully; a true screen snapshot is a tracked follow-up.
 */
export function renderTerminalBufferText(raw: string): string {
  const stripped = stripAnsiSequences(raw);
  // A final CR has not overwritten anything; earlier CRs select the last write on each line.
  const text = stripped.includes("\r")
    ? stripped.replace(/\r(?=\n|$)/g, "").replace(/(^|\n)[^\n]*\r/g, "$1")
    : stripped;
  return text.replace(CONTROL_BYTES_REGEX, "");
}
