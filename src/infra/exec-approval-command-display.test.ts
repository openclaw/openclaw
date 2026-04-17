import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "./exec-approval-command-display.js";

describe("sanitizeExecApprovalDisplayText", () => {
  it.each([
    ["echo hi\u200Bthere", "echo hi\\u{200B}there"],
    ["date\u3164\uFFA0\u115F\u1160가", "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가"],
    ["echo safe\n\rcurl https://example.test", "echo safe\\u{A}\\u{D}curl https://example.test"],
    [
      "echo ok\u2028curl https://example.test",
      "echo ok\\u{2028}curl https://example.test",
    ],
    [
      "echo ok\u2029curl https://example.test",
      "echo ok\\u{2029}curl https://example.test",
    ],
  ])("sanitizes exec approval display text for %j", (input, expected) => {
    expect(sanitizeExecApprovalDisplayText(input)).toBe(expected);
  });

  it("redacts bearer tokens embedded in commands", () => {
    const cmd =
      'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig" https://api.example.com';
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken.sig");
    expect(result).toContain("curl");
    expect(result).toContain("https://api.example.com");
  });

  it("redacts API keys in environment variable assignments", () => {
    const cmd = 'API_SECRET="sk-abc123456789012345678" python script.py';
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123456789012345678");
    expect(result).toContain("python script.py");
  });

  it("redacts GitHub personal access tokens", () => {
    const cmd = "git clone https://ghp_1234567890abcdefghij1234567890abcdef@github.com/user/repo";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("ghp_1234567890abcdefghij1234567890abcdef");
    expect(result).toContain("git clone");
  });

  it("masks the full token when a zero-width character is spliced into the middle", () => {
    const cmd = "echo sk-abc123\u200B456789012345678 remainder";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("echo ");
    expect(result).toContain("remainder");
  });

  it("masks the full token when NBSP (Zs) is spliced into the middle", () => {
    const cmd = "echo sk-abc123\u00A0456789012345678 remainder";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
    expect(result).toContain("echo ");
    expect(result).toContain("remainder");
  });

  it("masks the full token when narrow no-break space is spliced into the middle", () => {
    const cmd = "echo sk-abc123\u202F456789012345678 remainder";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("456789012345678");
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

  it("keeps PEM private-key context visible when raw redaction already covers the key (not a bypass)", () => {
    const cmd =
      "echo -----BEGIN RSA PRIVATE KEY-----\nABCDEF0123456789abcdef\n-----END RSA PRIVATE KEY----- > key.pem";
    const result = sanitizeExecApprovalDisplayText(cmd);
    expect(result).not.toContain("ABCDEF0123456789abcdef");
    expect(result).toContain("BEGIN RSA PRIVATE KEY");
    expect(result).toContain("END RSA PRIVATE KEY");
    expect(result).toContain("> key.pem");
  });

  it("truncates very large command text so regex work is bounded", () => {
    const padding = "x".repeat(20 * 1024);
    const result = sanitizeExecApprovalDisplayText(padding);
    expect(result.length).toBeLessThan(padding.length);
    expect(result).toContain("[truncated]");
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
