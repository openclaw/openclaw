import { describe, expect, it } from "vitest";
import { normalizeTelegramCommandName } from "./telegram-custom-commands.js";

describe("normalizeTelegramCommandName", () => {
  it("removes leading slash", () => {
    expect(normalizeTelegramCommandName("/help")).toBe("help");
  });

  it("lowercases command names", () => {
    expect(normalizeTelegramCommandName("HELP")).toBe("help");
  });

  it("replaces hyphens with underscores (#19145)", () => {
    expect(normalizeTelegramCommandName("export-session")).toBe("export_session");
  });

  it("replaces hyphens with underscores when slash is present", () => {
    expect(normalizeTelegramCommandName("/export-session")).toBe("export_session");
  });

  it("replaces multiple hyphens with underscores", () => {
    expect(normalizeTelegramCommandName("help-me-please")).toBe("help_me_please");
  });

  it("preserves underscores", () => {
    expect(normalizeTelegramCommandName("normal_command")).toBe("normal_command");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeTelegramCommandName("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeTelegramCommandName("   ")).toBe("");
  });

  it("handles mixed case with hyphens", () => {
    expect(normalizeTelegramCommandName("EXPORT-SESSION")).toBe("export_session");
  });
});
