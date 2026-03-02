import { describe, expect, it } from "vitest";
import {
  formatToolDetail,
  formatToolFeedbackDiscord,
  formatToolResultBlockDiscord,
  formatToolSummary,
  resolveToolDisplay,
} from "./tool-display.js";

describe("MCP tool name normalization", () => {
  it("strips mcp__server__prefix from tool names", () => {
    const display = resolveToolDisplay({ name: "mcp__claude-code-mcp__claude_code" });
    expect(display.name).toBe("claude_code");
    expect(display.title).toBe("Claude Code");
    expect(display.emoji).toBe("🔧");
  });

  it("strips mcp prefix for unknown MCP tools", () => {
    const display = resolveToolDisplay({ name: "mcp__filesystem__read_file" });
    expect(display.name).toBe("read_file");
    expect(display.title).toBe("Read File");
  });

  it("leaves non-MCP tool names unchanged", () => {
    const display = resolveToolDisplay({ name: "read" });
    expect(display.name).toBe("read");
    expect(display.title).toBe("Read");
  });

  it("formats claude_code summary with detail only (no label)", () => {
    const summary = formatToolSummary(
      resolveToolDisplay({
        name: "mcp__claude-code-mcp__claude_code",
        args: { prompt: "list files in /tmp" },
      }),
    );
    expect(summary).toBe("🔧 list files in /tmp");
  });
});

describe("tool display detailOnly", () => {
  it("marks claude_code as detailOnly", () => {
    const display = resolveToolDisplay({ name: "mcp__claude-code-mcp__claude_code" });
    expect(display.detailOnly).toBe(true);
  });

  it("does not set detailOnly for regular tools", () => {
    const display = resolveToolDisplay({ name: "read" });
    expect(display.detailOnly).toBe(false);
  });

  it("falls back to label format when detailOnly tool has no detail", () => {
    const summary = formatToolSummary(
      resolveToolDisplay({ name: "mcp__claude-code-mcp__claude_code" }),
    );
    expect(summary).toBe("🔧 Claude Code");
  });
});

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
          timeoutSeconds: 0,
        },
      }),
    );

    expect(detail).toBe("double-message-bug-gpt");
  });

  it("includes only truthy boolean details", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "message",
        args: {
          action: "react",
          provider: "discord",
          to: "chan-1",
          remove: false,
        },
      }),
    );

    expect(detail).toContain("provider discord");
    expect(detail).toContain("to chan-1");
    expect(detail).not.toContain("remove");
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_history",
        args: {
          sessionKey: "agent:main:main",
          limit: 20,
          includeTools: true,
        },
      }),
    );

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });
});

describe("formatToolFeedbackDiscord", () => {
  it("formats Bash with command in inline code, no colon", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "git status" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toBe("*Running `git status`...*");
    expect(result).not.toContain(":");
  });

  it("formats Bash without command as generic message", () => {
    const display = resolveToolDisplay({ name: "Bash" });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toBe("*Running a command...*");
  });

  it("formats Read with file path in inline code", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/home/user/project/src/index.ts" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("*Reading `");
    expect(result).toContain("index.ts");
    expect(result).not.toContain(":");
  });

  it("formats Write with file path", () => {
    const display = resolveToolDisplay({
      name: "Write",
      args: { path: "/tmp/output.txt" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("*Writing `");
    expect(result).toContain("output.txt");
  });

  it("formats Edit with file path", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/main.ts" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("*Editing `");
    expect(result).toContain("main.ts");
  });

  it("formats search tools with query in inline code", () => {
    const display = resolveToolDisplay({
      name: "web_search",
      args: { query: "vitest fake timers" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("*Searching `vitest fake timers`...*");
  });

  it("formats WebFetch with URL in inline code", () => {
    const display = resolveToolDisplay({
      name: "web_fetch",
      args: { url: "https://example.com" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("*Fetching `https://example.com`...*");
  });

  it("truncates long Bash commands at 120 chars", () => {
    const longCmd = "a".repeat(200);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: longCmd },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain("...");
  });

  it("strips stderr redirections and trailing pipes from Bash commands", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "todoist list 2>/dev/null | head -30" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toBe("*Running `todoist list`...*");
    expect(result).not.toContain("2>/dev/null");
    expect(result).not.toContain("head");
  });

  it("uses only the first line of multi-line Bash commands", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "echo hello\necho world\necho done" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toContain("echo hello");
    expect(result).not.toContain("echo world");
  });

  it("formats claude_code detailOnly with detail", () => {
    const display = resolveToolDisplay({
      name: "mcp__claude-code-mcp__claude_code",
      args: { prompt: "list files in /tmp" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toBe("*list files in /tmp...*");
  });

  it("formats unknown tools with label and detail in code", () => {
    const display = resolveToolDisplay({
      name: "custom_tool",
      args: { path: "/some/path" },
    });
    const result = formatToolFeedbackDiscord(display);
    expect(result).toBe("*Custom Tool `/some/path`...*");
  });
});

describe("formatToolResultBlockDiscord", () => {
  it("formats Read with language-hinted code fence for .ts files", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: 'export const port = 3000;\nexport const host = "localhost";',
        lineCount: 2,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("*Read* (`/src/config.ts`)");
    expect(result).toContain("```ts\n");
    expect(result).toContain("export const port = 3000;");
    // No remaining indicator for small output
    expect(result).not.toContain("remaining");
  });

  it("formats Read with language hint when detail includes line range", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/handler.ts", offset: 530, limit: 50 },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "sendingStatus = true;\ntry {",
        lineCount: 2,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```ts\n");
    // Code fence should be ```ts, not ```ts:530-580
    expect(result).not.toContain("```ts:");
  });

  it("formats Read with language-hinted code fence for .json files", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/app/package.json" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '{ "name": "test" }',
        lineCount: 1,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```json\n");
    expect(result).not.toContain("remaining");
  });

  it("formats Bash with command header and plaintext code fence", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "git status" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "On branch main\nnothing to commit",
      lineCount: 2,
      isError: false,
    });
    expect(result).toContain("*Bash* (`git status`)");
    expect(result).toContain("```\n");
    expect(result).toContain("On branch main");
  });

  it("formats Edit with plaintext code fence when no args provided", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/types.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "Successfully replaced text in /src/types.ts.",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("*Edit* (`/src/types.ts`)");
    expect(result).toContain("```\n");
  });

  it("formats Edit with diff block when old_string and new_string are provided", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Successfully replaced text in /src/config.ts.",
        lineCount: 1,
        isError: false,
      },
      { old_string: "const port = 3000;", new_string: "const port = 8080;" },
    );
    expect(result).toContain("*Edit* (`/src/config.ts`)");
    expect(result).toContain("```diff\n");
    expect(result).toContain("- const port = 3000;");
    expect(result).toContain("+ const port = 8080;");
  });

  it("falls back to raw output when Edit args are missing old_string", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Successfully replaced text in /src/config.ts.",
        lineCount: 1,
        isError: false,
      },
      { new_string: "const port = 8080;" },
    );
    expect(result).toContain("```\n");
    expect(result).not.toContain("```diff");
    expect(result).toContain("Successfully replaced");
  });

  it("shows raw output for Edit errors even when args have old/new strings", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Error: old_string not found in file.",
        lineCount: 1,
        isError: true,
      },
      { old_string: "foo", new_string: "bar" },
    );
    expect(result).not.toContain("```diff");
    expect(result).toContain("Error: old_string not found");
  });

  it("formats Edit diff with oldText/newText naming (pi-coding-agent)", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Successfully replaced text in /src/config.ts.",
        lineCount: 1,
        isError: false,
      },
      { oldText: "const port = 3000;", newText: "const port = 8080;" },
    );
    expect(result).toContain("```diff\n");
    expect(result).toContain("- const port = 3000;");
    expect(result).toContain("+ const port = 8080;");
  });

  it("truncates long Edit diffs to 10 visible lines", () => {
    const oldLines = Array.from({ length: 8 }, (_, i) => `old line ${i + 1}`);
    const newLines = Array.from({ length: 8 }, (_, i) => `new line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/big.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Successfully replaced text.",
        lineCount: 1,
        isError: false,
      },
      { old_string: oldLines.join("\n"), new_string: newLines.join("\n") },
    );
    expect(result).toContain("```diff\n");
    // 8 old + 8 new = 16 diff lines, only 10 should show
    expect(result).toContain("...(6 lines remaining)");
  });

  it("formats Grep with detail", () => {
    const display = resolveToolDisplay({
      name: "Grep",
      args: { pattern: "sessionId", path: "src/**/*.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "src/store.ts\nsrc/routing.ts",
      lineCount: 2,
      isError: false,
    });
    expect(result).toContain("*Grep*");
    expect(result).toContain("src/store.ts");
  });

  it("shows remaining count inside code block when >10 non-blank lines", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat bigfile.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.slice(0, 12).join("\n"),
      lineCount: 25,
      isError: false,
    });
    expect(result).toContain("line 1");
    expect(result).toContain("line 10");
    expect(result).not.toContain("line 11");
    // Remaining indicator is inside the code block
    expect(result).toContain("...(15 lines remaining)");
    expect(result).toContain("...(15 lines remaining)\n```");
    // No external footer
    expect(result).not.toContain("*(");
  });

  it("returns header only when no output preview", () => {
    const display = resolveToolDisplay({
      name: "Write",
      args: { path: "/tmp/out.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      isError: false,
    });
    expect(result).toBe("*Write* (`/tmp/out.txt`)");
    expect(result).not.toContain("```");
  });

  it("shows error marker when no output and isError", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "false" },
    });
    const result = formatToolResultBlockDiscord(display, {
      isError: true,
    });
    expect(result).toContain("*(error)*");
  });

  it("preserves pipe chains in Bash result header", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "ls /tmp | head -5" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "a\nb\nc\nd\ne",
      lineCount: 5,
      isError: false,
    });
    expect(result).toContain("*Bash* (`ls /tmp | head -5`)");
    expect(result).not.toContain("remaining");
  });

  it("formats MCP tools with title and detail", () => {
    const display = resolveToolDisplay({
      name: "mcp__todoist__get_tasks",
      args: { project: "OpenClaw" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "3 tasks found",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("*Get Tasks*");
    expect(result).toContain("3 tasks found");
  });

  it("formats Web Search results", () => {
    const display = resolveToolDisplay({
      name: "web_search",
      args: { query: "vitest docs" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "1. Vitest - https://vitest.dev\n2. Getting Started",
      lineCount: 2,
      isError: false,
    });
    expect(result).toContain("*Web Search* (`vitest docs`)");
    expect(result).toContain("vitest.dev");
  });

  it("handles single-line output without remaining indicator", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/tmp/one.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "single line",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("single line");
    expect(result).not.toContain("remaining");
  });
});

describe("formatToolResultBlockDiscord language detection", () => {
  it("formats Gateway tool result with json code fence", () => {
    const display = resolveToolDisplay({
      name: "gateway",
      args: { action: "config.get" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '{\n  "ok": true,\n  "config": {}\n}',
        lineCount: 4,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```json\n");
  });

  it("formats Cron tool result with json code fence", () => {
    const display = resolveToolDisplay({
      name: "cron",
      args: { action: "list" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '[\n  { "id": "abc", "schedule": "0 * * * *" }\n]',
        lineCount: 3,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```json\n");
  });

  it("detects json from content for unknown MCP tool", () => {
    const display = resolveToolDisplay({
      name: "mcp__custom__list_items",
      args: {},
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '{\n  "items": [\n    { "id": 1 },\n    { "id": 2 }\n  ]\n}',
        lineCount: 6,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```json\n");
  });

  it("detects json array from content for unknown tool", () => {
    const display = resolveToolDisplay({
      name: "mcp__custom__query",
      args: {},
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '[{"id": 1, "name": "test"}, {"id": 2}]',
        lineCount: 1,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```json\n");
  });

  it("detects diff output", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "git diff" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line",
        lineCount: 5,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    expect(result).toContain("```diff\n");
  });

  it("detects bash from shebang", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/tmp/script" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: '#!/bin/bash\nset -euo pipefail\necho "hello"',
        lineCount: 3,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    // No file extension, so tier 1 skips. Tier 3 detects bash.
    expect(result).toContain("```bash\n");
  });

  it("does not add language hint for plain Bash text output", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "git status" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "On branch main\nnothing to commit",
      lineCount: 2,
      isError: false,
    });
    expect(result).toContain("```\n");
    expect(result).not.toContain("```json");
    expect(result).not.toContain("```bash");
  });

  it("does not add language hint for Edit status message", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/types.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "Successfully replaced text in /src/types.ts.",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("```\n");
  });

  it("does not add language hint for short plain text", () => {
    const display = resolveToolDisplay({
      name: "mcp__todoist__get_tasks",
      args: {},
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "3 tasks found",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("```\n");
    expect(result).not.toContain("```json");
  });

  it("Read tool uses file extension over content detection", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/config.yaml" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "name: openclaw\nversion: 1.0.0",
        lineCount: 2,
        isError: false,
      },
      undefined,
      { codeLangHints: true },
    );
    // Tier 1 (file extension) takes precedence
    expect(result).toContain("```yaml\n");
  });
});

describe("formatToolResultBlockDiscord codeLangHints disabled (default)", () => {
  it("strips language hints by default", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "export const port = 3000;",
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("```\n");
    expect(result).not.toContain("```ts");
  });

  it("strips json hints for JSON tools by default", () => {
    const display = resolveToolDisplay({
      name: "gateway",
      args: { action: "config.get" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: '{\n  "ok": true\n}',
      lineCount: 3,
      isError: false,
    });
    expect(result).toContain("```\n");
    expect(result).not.toContain("```json");
  });

  it("strips diff hints when codeLangHints is disabled", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "git diff" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line",
      lineCount: 5,
      isError: false,
    });
    expect(result).toContain("```\n");
    expect(result).not.toContain("```diff");
  });

  it("preserves Edit diff blocks regardless of codeLangHints", () => {
    const display = resolveToolDisplay({
      name: "Edit",
      args: { path: "/src/config.ts" },
    });
    const result = formatToolResultBlockDiscord(
      display,
      {
        outputPreview: "Successfully replaced text.",
        lineCount: 1,
        isError: false,
      },
      { old_string: "const port = 3000;", new_string: "const port = 8080;" },
    );
    expect(result).toContain("```diff\n");
  });
});

describe("formatToolResultBlockDiscord blank line handling", () => {
  it("strips blank lines from the preview", () => {
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/app.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "line 1\n\nline 2\n\n\nline 3",
      lineCount: 6,
      isError: false,
    });
    // Blank lines should not appear between content lines
    expect(result).toContain("line 1\nline 2\nline 3");
    expect(result).not.toContain("\n\n");
  });

  it("returns header only when output is all blank lines", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "echo" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "\n\n\n\n",
      lineCount: 4,
      isError: false,
    });
    expect(result).toBe("*Bash* (`echo`)");
    expect(result).not.toContain("```");
  });

  it("blank lines do not count toward the 10-line limit", () => {
    // 8 non-blank lines interspersed with blanks (16 total elements).
    // All 8 should display since only non-blank lines count.
    const parts: string[] = [];
    for (let i = 1; i <= 8; i++) {
      parts.push(`content ${i}`);
      parts.push("");
    }
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/file.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: parts.join("\n"),
      lineCount: parts.length,
      isError: false,
    });
    expect(result).toContain("content 1");
    expect(result).toContain("content 8");
    expect(result).not.toContain("remaining");
  });

  it("remaining count includes blank lines from undisplayed portion", () => {
    // 12 non-blank lines with blank lines interspersed (24 total lines
    // in preview). totalLines = 50. We show 10 non-blank, consuming
    // some blanks along the way.
    const previewParts: string[] = [];
    for (let i = 1; i <= 12; i++) {
      previewParts.push(`line ${i}`);
      previewParts.push(""); // blank after each
    }
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/big.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: previewParts.join("\n"),
      lineCount: 50,
      isError: false,
    });
    expect(result).toContain("line 1");
    expect(result).toContain("line 10");
    expect(result).not.toContain("line 11");
    // We consumed 20 lines (10 non-blank + 10 blanks), so
    // remaining = 50 - 20 = 30
    expect(result).toContain("...(30 lines remaining)");
  });
});

describe("formatToolResultBlockDiscord column truncation", () => {
  it("truncates lines wider than 80 columns", () => {
    const wideLine = "x".repeat(120);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat wide.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: wideLine,
      lineCount: 1,
      isError: false,
    });
    // Should be truncated to 77 chars + "..."
    expect(result).toContain("x".repeat(77) + "...");
    expect(result).not.toContain("x".repeat(78));
  });

  it("does not truncate lines at or under 80 columns", () => {
    const exactLine = "y".repeat(80);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat ok.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: exactLine,
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain(exactLine);
    expect(result).not.toContain("y".repeat(80) + "...");
  });

  it("truncates each line independently", () => {
    const short = "short";
    const wide = "w".repeat(100);
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/tmp/mixed.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: `${short}\n${wide}`,
      lineCount: 2,
      isError: false,
    });
    expect(result).toContain("short");
    expect(result).toContain("w".repeat(77) + "...");
  });

  it("expands tabs to 4-space tab stops before truncating", () => {
    // "\tvalue" -> 4 spaces + "value" = 9 chars (no truncation)
    const tabLine = "\tvalue";
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat tabbed.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: tabLine,
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("    value");
    expect(result).not.toContain("\t");
  });

  it("aligns tabs to tab stops based on column position", () => {
    // "x\ty" -> "x" (col 1) + tab fills 3 spaces (to col 4) + "y"
    // = "x   y" (5 chars)
    const line = "x\ty";
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat aligned.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: line,
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("x   y");
  });

  it("truncates tab-expanded lines that exceed 80 columns", () => {
    // 20 tabs at 4 spaces each = 80 cols + "extra" = 85 cols
    const line = "\t".repeat(20) + "extra";
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat wide-tabs.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: line,
      lineCount: 1,
      isError: false,
    });
    // Should be 77 spaces + "..."
    expect(result).toContain(" ".repeat(77) + "...");
    expect(result).not.toContain("extra");
    expect(result).not.toContain("\t");
  });

  it("handles mixed tabs and regular text with correct tab stops", () => {
    // "ab\tcd\tef" -> "ab" (col 2) + 2 spaces (col 4) + "cd" (col 6)
    // + 2 spaces (col 8) + "ef" = "ab  cd  ef" (10 chars)
    const line = "ab\tcd\tef";
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat mixed.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: line,
      lineCount: 1,
      isError: false,
    });
    expect(result).toContain("ab  cd  ef");
  });
});

describe("formatToolResultBlockDiscord boundary cases", () => {
  it("exactly 10 non-blank lines with no remaining shows no indicator", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/ten.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 10,
      isError: false,
    });
    expect(result).toContain("line 1");
    expect(result).toContain("line 10");
    expect(result).not.toContain("remaining");
  });

  it("exactly 11 non-blank lines shows 1 line remaining", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/eleven.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 11,
      isError: false,
    });
    expect(result).toContain("line 10");
    expect(result).not.toContain("line 11");
    expect(result).toContain("...(1 line remaining)");
  });

  it("uses singular 'line' for 1 remaining", () => {
    const lines = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat file" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 11,
      isError: false,
    });
    expect(result).toContain("...(1 line remaining)");
    expect(result).not.toContain("lines remaining");
  });

  it("uses plural 'lines' for 2+ remaining", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat file" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 12,
      isError: false,
    });
    expect(result).toContain("...(2 lines remaining)");
  });

  it("preview has fewer than 10 non-blank lines but totalLines is larger", () => {
    // Preview only has 5 non-blank lines but totalLines says 100
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/partial.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 100,
      isError: false,
    });
    expect(result).toContain("line 5");
    expect(result).toContain("...(95 lines remaining)");
  });

  it("10 non-blank + blanks interspersed, totalLines matches exactly", () => {
    // 10 non-blank with 5 blanks interspersed = 15 lines total.
    // All 10 non-blank are displayed, linesConsumed = 15,
    // remaining = 15 - 15 = 0.
    const parts: string[] = [];
    for (let i = 1; i <= 10; i++) {
      parts.push(`item ${i}`);
      if (i % 2 === 0) {
        parts.push("");
      }
    }
    const display = resolveToolDisplay({
      name: "Read",
      args: { file_path: "/src/mixed.ts" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: parts.join("\n"),
      lineCount: parts.length,
      isError: false,
    });
    expect(result).toContain("item 1");
    expect(result).toContain("item 10");
    expect(result).not.toContain("remaining");
  });

  it("empty string output returns header only", () => {
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "true" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: "",
      lineCount: 0,
      isError: false,
    });
    expect(result).toBe("*Bash* (`true`)");
  });

  it("remaining indicator is inside the code fence, not outside", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `data ${i + 1}`);
    const display = resolveToolDisplay({
      name: "Bash",
      args: { command: "cat data.txt" },
    });
    const result = formatToolResultBlockDiscord(display, {
      outputPreview: lines.join("\n"),
      lineCount: 15,
      isError: false,
    });
    // The ...(N lines remaining) should appear before the closing ```
    const fenceClose = result.lastIndexOf("```");
    const remainingIdx = result.indexOf("...(5 lines remaining)");
    expect(remainingIdx).toBeGreaterThan(-1);
    expect(remainingIdx).toBeLessThan(fenceClose);
  });
});
