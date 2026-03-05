import { describe, expect, it } from "vitest";
import {
  applyPlaceholders,
  type PlaceholderContext,
} from "../../../src/agents/skills/placeholders.js";

describe("applyPlaceholders", () => {
  it("replaces simple placeholders", () => {
    const template = "Working directory: {{CWD}}";
    const context: PlaceholderContext = { CWD: "/home/user/project" };
    expect(applyPlaceholders(template, context)).toBe("Working directory: /home/user/project");
  });

  it("uses default values when placeholder is missing", () => {
    const template = "Args: {{ARGS|none provided}}";
    const context: PlaceholderContext = {};
    expect(applyPlaceholders(template, context)).toBe("Args: none provided");
  });

  it("uses default values when placeholder is empty", () => {
    const template = "Args: {{ARGS|none provided}}";
    const context: PlaceholderContext = { ARGS: "" };
    expect(applyPlaceholders(template, context)).toBe("Args: none provided");
  });

  it("prefers actual value over default", () => {
    const template = "Args: {{ARGS|none}}";
    const context: PlaceholderContext = { ARGS: "test" };
    expect(applyPlaceholders(template, context)).toBe("Args: test");
  });

  it("leaves empty when no value and no default", () => {
    const template = "Args: {{ARGS}}";
    const context: PlaceholderContext = {};
    expect(applyPlaceholders(template, context)).toBe("Args: ");
  });

  it("handles conditional blocks with truthy values", () => {
    const template = "{{#if SELECTION}}Selected: {{SELECTION}}{{/if}}";
    const context: PlaceholderContext = { SELECTION: "some text" };
    expect(applyPlaceholders(template, context)).toContain("Selected:");
  });

  it("hides conditional blocks with falsy values", () => {
    const template = "{{#if SELECTION}}Selected: {{SELECTION}}{{/if}}";
    const context: PlaceholderContext = {};
    expect(applyPlaceholders(template, context)).toBe("");
  });

  it("handles nested placeholders in conditionals", () => {
    const template = "{{#if ARGS}}Run with: {{ARGS}}{{/if}}";
    const context: PlaceholderContext = { ARGS: "--verbose" };
    expect(applyPlaceholders(template, context)).toBe("Run with: --verbose");
  });

  it("handles multiple conditionals", () => {
    const template = "{{#if CWD}}CWD: {{CWD}}{{/if}} {{#if ARGS}}ARGS: {{ARGS}}{{/if}}";
    const context: PlaceholderContext = { CWD: "/tmp", ARGS: "test" };
    expect(applyPlaceholders(template, context)).toBe("CWD: /tmp ARGS: test");
  });

  it("handles mixed content", () => {
    const template = `
# Skill Example

Working in: {{CWD}}

{{#if ARGS}}
Arguments provided: {{ARGS}}
{{/if}}

{{#if SELECTION}}
Selected text:
{{SELECTION}}
{{/if}}

Default behavior: {{MODE|auto}}
`;
    const context: PlaceholderContext = {
      CWD: "/workspace",
      ARGS: "--flag",
      MODE: undefined,
    };
    const result = applyPlaceholders(template, context);
    expect(result).toContain("Working in: /workspace");
    expect(result).toContain("Arguments provided: --flag");
    expect(result).not.toContain("Selected text:");
    expect(result).toContain("Default behavior: auto");
  });

  it("treats whitespace-only values as falsy", () => {
    const template = "{{#if ARGS}}Has args{{/if}}";
    const context: PlaceholderContext = { ARGS: "   " };
    expect(applyPlaceholders(template, context)).toBe("");
  });

  it("treats 'false' string as falsy", () => {
    const template = "{{#if FLAG}}Enabled{{/if}}";
    const context: PlaceholderContext = { FLAG: "false" };
    expect(applyPlaceholders(template, context)).toBe("");
  });

  it("truncates expanded content exceeding 50KB", () => {
    const largeContent = "x".repeat(60_000);
    const template = "Content: {{DATA}}";
    const context: PlaceholderContext = { DATA: largeContent };
    const result = applyPlaceholders(template, context);
    expect(result.length).toBeLessThanOrEqual(50_000 + 100); // 50KB + truncation message
    expect(result).toContain("[... truncated: expanded skill content exceeded 50KB limit]");
  });

  it("wraps SELECTION in fenced block to reduce prompt injection risk", () => {
    const template = "User selected: {{SELECTION}}";
    const context: PlaceholderContext = { SELECTION: "malicious content" };
    const result = applyPlaceholders(template, context);
    expect(result).toBe("User selected: ```\nmalicious content\n```");
  });
});
