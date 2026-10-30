import { expect, it } from "vitest";
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

function runPlan(commandText: string, commandPreview: string, argv = ["echo", "hi"]) {
  return {
    argv,
    cwd: null,
    commandText,
    commandPreview,
    agentId: null,
    sessionKey: null,
  };
}

it.each([
  ["date\u3164\uFFA0\u115F\u1160가", "date\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가"],
  ["echo \uD83D", "echo \\u{D83D}"],
  ["echo sk-abc123\u00A0456789012345678", "echo sk-abc123\\u{A0}456789012345678"],
  ["echo sk-abc123\u{E0061}456789012345678", "echo sk-abc123\\u{E0061}456789012345678"],
  ["API_TOKEN = computeToken()", "API_TOKEN = computeToken()"],
  ["sk-abc123456789012345678", "sk-abc123456789012345678"],
  ["line1\nline2", "line1\\u{A}line2"],
])("preserves command content while exposing invisible characters in %j", (command, expected) => {
  const result = sanitizeExecApprovalDisplayText(command);
  expect(result).toBe(expected);
  expect(() => encodeURIComponent(result)).not.toThrow();
});

it.each(["x".repeat(20 * 1024), "a".repeat(16 * 1024 - 1) + "😀tail".repeat(3)])(
  "bounds display output without splitting surrogate pairs (%#)",
  (command) => {
    const result = sanitizeExecApprovalDisplayText(command);
    expect(result.length).toBeLessThan(command.length);
    expect(result).toContain("[truncated]");
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(result).not.toContain("\uD83D");
    expect(() => encodeURIComponent(result)).not.toThrow();
  },
);

it("refuses to display commands above the hard input cap", () => {
  const huge = "x".repeat(300 * 1024);
  const result = sanitizeExecApprovalDisplayText(huge);
  expect(result).toContain("exceeds display size limit");
  expect(result.length).toBeLessThan(1024);
});
it("preserves warning prose without escaping newlines", () => {
  const warning = "Token:\nsk-abc123456789012345678";
  const result = sanitizeExecApprovalWarningText(warning);

  expect(result).toContain("Token:\n");
  expect(result).toContain("sk-abc123456789012345678");
  expect(result).not.toContain("\\u{A}");
});
it("prefers explicit commands and drops identical trimmed previews", () => {
  expect(
    resolveExecApprovalCommandDisplay({
      command: "echo hi",
      commandPreview: "  echo hi  ",
      host: "gateway",
    }),
  ).toEqual({ commandText: "echo hi", commandPreview: null });
});
it("falls back to node plans and sanitizes their previews", () => {
  const commandText = 'python3 -c "print(1)"';
  const systemRunPlan = runPlan(commandText, "print\u200B(1)", ["python3", "-c", "print(1)"]);
  expect(resolveExecApprovalCommandDisplay({ command: "", host: "node", systemRunPlan })).toEqual({
    commandText,
    commandPreview: "print\\u{200B}(1)",
  });
});
it("ignores plan fallback for non-node hosts", () => {
  expect(
    resolveExecApprovalCommandDisplay({
      command: "",
      host: "sandbox",
      systemRunPlan: runPlan("echo hi", "echo hi"),
    }),
  ).toEqual({ commandText: "", commandPreview: null });
});
