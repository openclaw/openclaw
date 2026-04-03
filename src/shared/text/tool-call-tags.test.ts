import { describe, expect, it } from "vitest";
import { stripGenericToolCallXml } from "./tool-call-tags.js";

describe("stripGenericToolCallXml", () => {
  it("returns empty/falsy input unchanged", () => {
    expect(stripGenericToolCallXml("")).toBe("");
  });

  it("returns text without tool_call tags unchanged", () => {
    expect(stripGenericToolCallXml("Hello world")).toBe("Hello world");
  });

  it("strips <tool_call>...</tool_call> blocks (exact issue #60494 pattern)", () => {
    const input =
      "Let me check the recent memory files now.\n\n" +
      '<tool_call> {"name": "find", "arguments": {"pattern": "memory/2026-04-0*.md", "path": "/root/.openclaw/workspace"}} </tool_call> ' +
      '<tool_call> {"name": "find", "arguments": {"pattern": "memory/2026-03-3*.md", "path": "/root/.openclaw/workspace"}} </tool_call>';
    const result = stripGenericToolCallXml(input);
    expect(result).not.toContain("<tool_call>");
    expect(result).not.toContain("</tool_call>");
    expect(result).not.toContain('"name": "find"');
    expect(result).toContain("Let me check the recent memory files now.");
  });

  it("strips multiple <tool_call> blocks from the reporter's second example", () => {
    const input =
      "Let me check the recent notes.\n\n" +
      '<tool_call> {"name": "read", "arguments": {"file_path": "/root/.openclaw/workspace/memory/2026-04-03.md"}} </tool_call> ' +
      '<tool_call> {"name": "read", "arguments": {"file_path": "/root/.openclaw/workspace/memory/2026-04-02.md"}} </tool_call> ' +
      '<tool_call> {"name": "read", "arguments": {"file_path": "/root/.openclaw/workspace/memory/2026-04-01.md"}} </tool_call>';
    const result = stripGenericToolCallXml(input);
    expect(result).not.toContain("<tool_call>");
    expect(result).not.toContain("</tool_call>");
    expect(result).not.toContain('"name": "read"');
    expect(result).toContain("Let me check the recent notes.");
  });

  it("strips <function_calls>...</function_calls> blocks", () => {
    const input =
      'Checking now. <function_calls>{"name": "exec", "args": {"cmd": "ls"}}</function_calls> Done.';
    const result = stripGenericToolCallXml(input);
    expect(result).not.toContain("<function_calls>");
    expect(result).not.toContain("</function_calls>");
    expect(result).toContain("Checking now. ");
    expect(result).toContain(" Done.");
  });

  it("strips <function_call>...</function_call> (singular)", () => {
    const input = 'Running: <function_call>{"name": "bash"}</function_call> ok';
    const result = stripGenericToolCallXml(input);
    expect(result).not.toContain("<function_call>");
    expect(result).toContain("Running: ");
    expect(result).toContain(" ok");
  });

  it("strips stray closing tags", () => {
    const input = "Before </tool_call> after";
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Before  after");
  });

  it("hides content from unclosed opening tag to end-of-string", () => {
    const input = 'Let me run.\n<tool_call>\n{"name": "find", "arguments": {}}\n';
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Let me run.\n");
    expect(result).not.toContain('"name"');
  });

  it("hides content from unclosed <function_call> to end-of-string", () => {
    const input = 'Checking. <function_call>{"name": "exec"}';
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Checking. ");
  });

  it("preserves text before unclosed block and hides the rest", () => {
    const input = "Visible text here.\n\n<tool_call>\npartial payload...";
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Visible text here.\n\n");
  });

  it("preserves tool_call tags inside code fences", () => {
    const input = [
      "```xml",
      '<tool_call> {"name": "find"} </tool_call>',
      "```",
      "",
      "Visible text",
    ].join("\n");
    expect(stripGenericToolCallXml(input)).toBe(input);
  });

  it("preserves inline code references to tool_call", () => {
    const input = "Use `<tool_call>` to invoke tools.";
    expect(stripGenericToolCallXml(input)).toBe(input);
  });

  it("treats self-closing <tool_call/> as complete without swallowing subsequent text", () => {
    const input = "Before <tool_call/> after this is visible.";
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Before  after this is visible.");
  });

  it("treats self-closing <function_call /> (with space) as complete", () => {
    const input = "Start <function_call /> end.";
    const result = stripGenericToolCallXml(input);
    expect(result).toBe("Start  end.");
  });
});
