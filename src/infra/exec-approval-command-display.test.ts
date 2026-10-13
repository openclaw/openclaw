// Verifies shell command display strings for exec approval prompts.
import { describe, expect, it } from "vitest";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "./exec-approval-text-sanitize.js";

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

describe("sanitizeExecApprovalDisplayText", () => {
  it.each([
    ["date\u3164\uFFA0\u115F\u1160가", "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가"],
    ["echo \uD83D", "echo \\u{D83D}"],
  ])("sanitizes exec approval display text for %j", (input, expected) => {
    const result = sanitizeExecApprovalDisplayText(input);
    expect(result).toBe(expected);
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  it("masks the full token when NBSP (Zs) is spliced into the middle", () => {
    const cmd = "echo sk-abc123\u00A0456789012345678 remainder";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("echo ");
    expect(result).toContain("remainder");
  });

  it("keeps newline boundaries visible as escape markers even when bypass is detected", () => {
    // Stripping invisibles lets the stripped-view greedy-match across the original newline
    // boundaries, so the trailing `line3` gets absorbed into the union mask alongside the
    // secret. The important guarantees are: (1) the secret is not visible, and (2) the
    // newlines that existed in the original are still visible as `\u{A}` escapes so the
    // operator is not misled about multi-line structure.
    const cmd = "line1\necho sk-abc123\u00A0456789012345678\nline3";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("line1");
    expect(result).toContain("\\u{A}");
  });

  it("detects bypass even when raw and stripped redactions happen to produce the same normalized length", () => {
    // Raw masks the 16-char prefix `sk-abc1234567890` as the fixed literal `***` while the
    // trailing 8 chars past the zero-width stay visible. The stripped view masks the full
    // 24-char token as `sk-abc…5678`. Both normalized outputs are the same length (11 chars),
    // so a length-based bypass check would falsely return the raw view and leak the tail.
    const cmd = "sk-abc1234567890\u200B12345678";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("12345678");
    expect(result).not.toContain("1234567890");
  });

  it("does not leak bearer tokens when bypass is triggered by a separate spliced secret", () => {
    // Bearer+NBSP is caught by the raw view (NBSP matches \s in non-u JS regex) but stripping
    // removes NBSP, turning `Bearer<jwt>` into a pattern the bearer regex no longer matches.
    // A separate spliced-invisible token triggers bypass detection, and the union-mask output
    // must cover both the bearer span (from raw) and the spliced sk- span (from stripped).
    const cmd =
      'curl -H "Authorization: Bearer\u00A0eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig" https://api.example.com; echo sk-abc123\u200B456789012345678';
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("https://api.example.com");
  });

  it("truncates the redacted output (not the raw input) so large commands are bounded", () => {
    const padding = "x".repeat(20 * 1024);
    const result = sanitizeExecApprovalDisplayText(padding);
    expect(result.length).toBeLessThan(padding.length);
    expect(result).toContain("[truncated]");
  });

  it("does not split surrogate pairs at the display truncation boundary", () => {
    const command = "a".repeat(16 * 1024 - 1) + "😀tail";
    const result = sanitizeExecApprovalDisplayText(command);

    expect(result).toContain("[truncated]");
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(result).not.toContain("\uD83D");
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  it("refuses to display commands above the hard input cap", () => {
    const huge = "x".repeat(300 * 1024);
    const result = sanitizeExecApprovalDisplayText(huge);
    expect(result).toContain("exceeds display size limit");
    expect(result.length).toBeLessThan(1024);
  });

  it("masks a secret spliced with an astral-plane invisible character", () => {
    // U+E0061 is a Cf (format) code point in the supplementary plane. Iterating the input by
    // UTF-16 code unit would see two surrogate halves, neither of which matches \p{Cf}, so
    // the splice would survive stripping and the stripped-view redaction would miss the
    // full token. Code-point iteration strips it correctly and bypass detection fires.
    const cmd = "echo sk-abc123\u{E0061}456789012345678 remainder";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("remainder");
  });

  it("keeps parsed form-body secrets masked when a separate spliced token triggers bypass rendering", () => {
    const cmd =
      "client_id=visible&client%5Fsecret=oauth,secret&safe=1 echo sk-abc123\u200B456789012345678";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("oauth,secret");
    expect(result).not.toContain(",secret");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("client_id=visible");
    expect(result).toContain("safe=1");
  });
});

describe("sanitizeExecApprovalWarningText", () => {
  it("redacts secrets in warning prose without escaping newlines", () => {
    const warning = "Token:\nsk-abc123456789012345678";
    const result = sanitizeExecApprovalWarningText(warning);

    expect(result).toContain("Token:\n");
    expect(result).not.toContain("sk-abc123456789012345678");
    expect(result).not.toContain("\\u{A}");
  });
});

describe("resolveExecApprovalCommandDisplay", () => {
  it.each([
    {
      name: "prefers explicit command fields and drops identical previews after trimming",
      input: {
        command: "echo hi",
        commandPreview: "  echo hi  ",
        host: "gateway" as const,
      },
      expected: {
        commandText: "echo hi",
        commandPreview: null,
      },
    },
    {
      name: "falls back to node systemRunPlan values and sanitizes preview text",
      input: {
        command: "",
        host: "node" as const,
        systemRunPlan: {
          argv: ["python3", "-c", "print(1)"],
          cwd: null,
          commandText: 'python3 -c "print(1)"',
          commandPreview: "print\u200B(1)",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: 'python3 -c "print(1)"',
        commandPreview: "print\\u{200B}(1)",
      },
    },
    {
      name: "ignores systemRunPlan fallback for non-node hosts",
      input: {
        command: "",
        host: "sandbox" as const,
        systemRunPlan: {
          argv: ["echo", "hi"],
          cwd: null,
          commandText: "echo hi",
          commandPreview: "echo hi",
          agentId: null,
          sessionKey: null,
        },
      },
      expected: {
        commandText: "",
        commandPreview: null,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveExecApprovalCommandDisplay(input)).toEqual(expected);
  });
});
