import { describe, expect, it } from "vitest";
import { downgradeApprovalMarkdownToPlaintext } from "./approval-markdown.runtime.js";

const APPROVAL_ID = "a7a8b519-2311-4dcd-bccf-d6ca1d737969";
const PENDING_COMMAND = 'curl -sS -o /dev/null -w "%{http_code}" https://example.com';

/** Shape every approval builder emits: fences in the body, id block last. */
function buildPrompt(command: string): string {
  return [
    "Approval required.",
    "Run:",
    "```txt\n/approve " + APPROVAL_ID + " allow-once\n```",
    "Pending command:",
    "```sh\n" + command + "\n```",
    `Host: gateway\nFull id: \`${APPROVAL_ID}\``,
  ].join("\n\n");
}

describe("downgradeApprovalMarkdownToPlaintext", () => {
  it("removes every canonical marker", () => {
    const out = downgradeApprovalMarkdownToPlaintext(buildPrompt(PENDING_COMMAND));
    expect(out).not.toContain("`");
    expect(out).not.toContain("```");
  });

  it("preserves the command, the id, and the approve instruction verbatim", () => {
    const out = downgradeApprovalMarkdownToPlaintext(buildPrompt(PENDING_COMMAND));
    // Substring, not whole-string equality: the projection trims the message's
    // outer edges, so byte-identity holds for body content, not the envelope.
    expect(out).toContain(PENDING_COMMAND);
    expect(out).toContain(`/approve ${APPROVAL_ID} allow-once`);
    expect(out).toContain(APPROVAL_ID);
  });

  it("does not rewrite punctuation-heavy command text", () => {
    // Pins mode: "plain-text". The speech projection collapses repeated
    // punctuation and punctuation-only lines, which would corrupt a command.
    const hostile = 'run --flag !! && echo "..." ; test **x** ; echo ---';
    const out = downgradeApprovalMarkdownToPlaintext(buildPrompt(hostile));
    expect(out).toContain(hostile);
  });

  it("preserves whitespace inside a fenced command", () => {
    const indented = "  indented --flag\ntrailing   \n\nafter-blank-line";
    const out = downgradeApprovalMarkdownToPlaintext(buildPrompt(indented));
    expect(out).toContain(indented);
  });

  it("keeps link destinations visible to the approver", () => {
    // Pins linkStyle: "label-and-url". Hiding a destination behind a label in
    // a prompt asking someone to approve an action is a security downgrade.
    const out = downgradeApprovalMarkdownToPlaintext(
      "Approve fetch of [the report](https://example.invalid/report).",
    );
    expect(out).toContain("https://example.invalid/report");
  });

  it("strips emphasis without touching the words", () => {
    const out = downgradeApprovalMarkdownToPlaintext(
      "**Approval required.** The command makes an _external_ network request.",
    );
    expect(out).toContain("Approval required.");
    expect(out).toContain("external");
    expect(out).not.toContain("**");
    expect(out).not.toContain("_external_");
  });
});
