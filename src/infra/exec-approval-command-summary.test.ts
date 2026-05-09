import { describe, expect, it } from "vitest";
import { summarizeExecApprovalCommandForPrompt } from "./exec-approval-command-summary.js";

describe("summarizeExecApprovalCommandForPrompt", () => {
  it("leaves short commands unchanged", () => {
    expect(summarizeExecApprovalCommandForPrompt("echo hello")).toEqual({
      text: "echo hello",
      truncated: false,
      totalLineCount: 1,
      shownLineCount: 1,
      hiddenLineCount: 0,
      totalCharCount: 10,
      hiddenCharCount: 0,
    });
  });

  it("shows only the first logical lines and keeps escaped newline markers visible", () => {
    const command = [
      "line 1\\u{A}",
      "line 2\\u{A}",
      "line 3\\u{A}",
      "line 4\\u{A}",
      "line 5\\u{A}",
      "line 6\\u{A}",
      "line 7",
    ].join("");

    const summary = summarizeExecApprovalCommandForPrompt(command, {
      maxLines: 3,
      maxChars: 1_000,
    });

    expect(summary.text).toBe(
      "line 1\\u{A}\nline 2\\u{A}\nline 3\\u{A}\n...[truncated: showing first 3 of 7 lines; 43 chars hidden]",
    );
    expect(summary.truncated).toBe(true);
    expect(summary.hiddenLineCount).toBe(4);
    expect(summary.text).not.toContain("line 6");
  });

  it("bounds long single-line commands", () => {
    const command = `python -c "${"x".repeat(200)}"`;

    const summary = summarizeExecApprovalCommandForPrompt(command, {
      maxLines: 5,
      maxChars: 40,
    });

    expect(summary.text).toMatch(/^python -c "x+/u);
    expect(summary.text).toContain("...[truncated:");
    expect(summary.text).toContain("chars hidden");
    expect(summary.text).not.toContain("x".repeat(80));
  });
});
