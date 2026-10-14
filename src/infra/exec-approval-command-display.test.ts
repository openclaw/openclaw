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

  it.each([
    ["echo sk-abc123\u00A0456789012345678", "echo sk-abc123\\u{A0}456789012345678"],
    ["echo sk-abc123\u{E0061}456789012345678", "echo sk-abc123\\u{E0061}456789012345678"],
    ["API_TOKEN = computeToken()", "API_TOKEN = computeToken()"],
    ["sk-abc123456789012345678", "sk-abc123456789012345678"],
    ["line1\nline2", "line1\\u{A}line2"],
  ])("preserves command content while exposing invisible characters in %j", (command, expected) => {
    expect(sanitizeExecApprovalDisplayText(command)).toBe(expected);
  });

  it("truncates display output so large commands are bounded", () => {
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
});

describe("sanitizeExecApprovalWarningText", () => {
  it("preserves warning prose without escaping newlines", () => {
    const warning = "Token:\nsk-abc123456789012345678";
    const result = sanitizeExecApprovalWarningText(warning);

    expect(result).toContain("Token:\n");
    expect(result).toContain("sk-abc123456789012345678");
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
