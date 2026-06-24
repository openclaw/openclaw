// Tests for action-critical output classifier.
import { describe, expect, it } from "vitest";
import {
  extractActionCriticalLines,
  hasActionCriticalContent,
  isActionCriticalLine,
} from "./action-critical-output.js";

describe("isActionCriticalLine", () => {
  it("detects Microsoft device-login URLs", () => {
    expect(isActionCriticalLine("To sign in, use a web browser to open https://login.microsoft.com/device")).toBe(true);
    expect(isActionCriticalLine("Open https://microsoft.com/devicelogin in your browser")).toBe(true);
  });

  it("detects device/verification codes", () => {
    expect(isActionCriticalLine("and enter the code FAKE-CODE-270 to authenticate.")).toBe(true);
    expect(isActionCriticalLine("Your verification code is: ABCD-1234-EFGH")).toBe(true);
    expect(isActionCriticalLine("Setup code: 1234-5678")).toBe(true);
    expect(isActionCriticalLine("Device code: WXYZ-9876")).toBe(true);
    expect(isActionCriticalLine("enter this code: XXXXX-YYYYY")).toBe(true);
  });

  it("detects localhost callback URLs", () => {
    expect(isActionCriticalLine("Open http://localhost:9876 to complete setup")).toBe(true);
    expect(isActionCriticalLine("Callback: http://127.0.0.1:3000/callback")).toBe(true);
  });

  it("detects explicit next-action instructions", () => {
    expect(isActionCriticalLine("To sign in, open a web browser")).toBe(true);
    expect(isActionCriticalLine("Go to https://example.com/activate")).toBe(true);
    expect(isActionCriticalLine("Copy this code and paste it in the browser")).toBe(true);
    expect(isActionCriticalLine("Use this URL to authenticate")).toBe(true);
  });

  it("returns false for ordinary output lines", () => {
    expect(isActionCriticalLine("Starting build process...")).toBe(false);
    expect(isActionCriticalLine("CRON-FILLER-270-line-1")).toBe(false);
    expect(isActionCriticalLine("DONE")).toBe(false);
    expect(isActionCriticalLine("Error: file not found")).toBe(false);
    expect(isActionCriticalLine("")).toBe(false);
    expect(isActionCriticalLine("[INFO] Task completed successfully")).toBe(false);
  });

  it("returns false for URLs without auth context", () => {
    expect(isActionCriticalLine("Download from https://example.com/file.zip")).toBe(false);
    expect(isActionCriticalLine("See https://docs.example.com for more info")).toBe(false);
  });
});

describe("hasActionCriticalContent", () => {
  it("returns true when multi-line text contains action-critical content", () => {
    const text = [
      "Starting job...",
      "To sign in, use a web browser to open https://login.microsoft.com/device",
      "and enter the code FAKE-CODE-270 to authenticate.",
      "Job complete.",
    ].join("\n");
    expect(hasActionCriticalContent(text)).toBe(true);
  });

  it("returns false for ordinary multi-line text", () => {
    const text = [
      "line 1",
      "line 2",
      "line 3",
    ].join("\n");
    expect(hasActionCriticalContent(text)).toBe(false);
  });

  it("returns true for empty-adjacent content (edge)", () => {
    expect(hasActionCriticalContent("https://login.microsoft.com/device")).toBe(true);
    expect(hasActionCriticalContent("")).toBe(false);
  });
});

describe("extractActionCriticalLines", () => {
  it("extracts action-critical lines from mixed output", () => {
    const text = [
      "Filler line 1",
      "To sign in, use a web browser to open https://login.microsoft.com/device",
      "and enter the code FAKE-CODE-270 to authenticate.",
      "Filler line 2",
    ].join("\n");

    const lines = extractActionCriticalLines(text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("login.microsoft.com");
    expect(lines[1]).toContain("FAKE-CODE-270");
  });

  it("returns empty array when no action-critical lines present", () => {
    const text = [
      "line 1",
      "line 2",
    ].join("\n");
    expect(extractActionCriticalLines(text)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractActionCriticalLines("")).toEqual([]);
  });

  it("deduplicates identical lines (via caller, but this is the raw extract)", () => {
    const text = [
      "To sign in, open https://login.microsoft.com/device",
      "Filler",
      "To sign in, open https://login.microsoft.com/device",
    ].join("\n");
    const lines = extractActionCriticalLines(text);
    // Raw extract does not deduplicate — that's the caller's responsibility.
    expect(lines).toHaveLength(2);
  });

  it("preserves line order", () => {
    const text = [
      "Filler A",
      "To sign in, open https://login.microsoft.com/device",
      "Filler B",
      "Your verification code is: ABCD-1234",
      "Filler C",
    ].join("\n");

    const lines = extractActionCriticalLines(text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("login.microsoft.com");
    expect(lines[1]).toContain("ABCD-1234");
  });
});
