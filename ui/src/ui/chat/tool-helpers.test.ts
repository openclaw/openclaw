import { describe, expect, it } from "vitest";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

describe("tool-helpers", () => {
  describe("formatToolOutputForSidebar", () => {
    it("formats valid JSON object as code block", () => {
      const input = '{"name":"test","value":123}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
{
  "name": "test",
  "value": 123
}
\`\`\``);
    });

    it("formats valid JSON array as code block", () => {
      const input = "[1, 2, 3]";
      const result = formatToolOutputForSidebar(input);

      expect(result).toBe(`\`\`\`json
[
  1,
  2,
  3
]
\`\`\``);
    });

    it("handles nested JSON objects", () => {
      const input = '{"outer":{"inner":"value"}}';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"outer"');
      expect(result).toContain('"inner"');
    });

    it("formats plain text into an output section", () => {
      const input = "This is plain text output";
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("### Output");
      expect(result).toContain("```text");
      expect(result).toContain("This is plain text output");
    });

    it("formats invalid JSON-like strings as plain output", () => {
      const resultObject = formatToolOutputForSidebar("{not valid json");
      const resultArray = formatToolOutputForSidebar("[not valid json");

      expect(resultObject).toContain("### Output");
      expect(resultObject).toContain("{not valid json");
      expect(resultArray).toContain("### Output");
      expect(resultArray).toContain("[not valid json");
    });

    it("trims whitespace before detecting JSON", () => {
      const input = '   {"trimmed": true}   ';
      const result = formatToolOutputForSidebar(input);

      expect(result).toContain("```json");
      expect(result).toContain('"trimmed"');
    });

    it("handles empty string", () => {
      const result = formatToolOutputForSidebar("");
      expect(result).toBe("");
    });

    it("handles whitespace-only string", () => {
      const result = formatToolOutputForSidebar("   ");
      expect(result).toBe("   ");
    });

    it("extracts read content from structured JSON payload", () => {
      const input = JSON.stringify({
        path: "src/app.ts",
        content: "line one\nline two",
      });
      const result = formatToolOutputForSidebar(input, {
        toolName: "read",
        args: { path: "src/app.ts" },
      });

      expect(result).toContain("src/app.ts");
      expect(result).toContain("line one");
      expect(result).toContain("line two");
      expect(result).toContain("```");
      expect(result).toContain("Read Files");
    });

    it("uses args path for plain-text read output", () => {
      const result = formatToolOutputForSidebar("alpha\nbeta", {
        toolName: "read",
        args: { path: "docs/readme.md" },
      });

      expect(result).toContain("Read Files");
      expect(result).toContain("docs/readme.md");
      expect(result).toContain("alpha");
      expect(result).toContain("beta");
    });

    it("shows read file path even when content is missing", () => {
      const result = formatToolOutputForSidebar("", {
        toolName: "read",
        args: { file_path: "docs/empty.md" },
      });

      expect(result).toContain("Read Files");
      expect(result).toContain("docs/empty.md");
      expect(result).toContain("No file content captured");
    });

    it("renders edit arguments as diff even without tool result text", () => {
      const result = formatToolOutputForSidebar("", {
        toolName: "edit",
        args: {
          path: "src/app.ts",
          old_string: "alpha\nbeta",
          new_string: "alpha\ngamma",
        },
      });

      expect(result).toContain("```diff");
      expect(result).toContain("-beta");
      expect(result).toContain("+gamma");
      expect(result).toContain("src/app.ts");
    });

    it("formats exec output with status and stdio sections", () => {
      const result = formatToolOutputForSidebar(
        JSON.stringify({
          exitCode: 1,
          durationMs: 245,
          cwd: "H:/AIProjects/openclaw",
          stdout: "ok line",
          stderr: "failure line",
        }),
        {
          toolName: "exec",
          args: { cmd: "pnpm test" },
        },
      );

      expect(result).toContain("Execution Result");
      expect(result).toContain("Exit Code");
      expect(result).toContain("Stdout");
      expect(result).toContain("Stderr");
    });

    it("formats web_fetch output with request metadata", () => {
      const result = formatToolOutputForSidebar(
        JSON.stringify({
          status: 200,
          contentType: "text/html",
          content: "<html>Hello</html>",
        }),
        {
          toolName: "web_fetch",
          args: { url: "https://openclaw.ai" },
        },
      );

      expect(result).toContain("Fetch Result");
      expect(result).toContain("https://openclaw.ai");
      expect(result).toContain("Status");
      expect(result).toContain("Body Preview");
    });

    it("formats web_search output into ranked results", () => {
      const result = formatToolOutputForSidebar(
        JSON.stringify({
          results: [
            { title: "OpenClaw Docs", url: "https://docs.openclaw.ai", snippet: "Docs home" },
          ],
        }),
        {
          toolName: "web_search",
          args: { query: "openclaw docs" },
        },
      );

      expect(result).toContain("Search Results");
      expect(result).toContain("Matches");
      expect(result).toContain("OpenClaw Docs");
      expect(result).toContain("docs.openclaw.ai");
    });

    it("formats write output with file metadata and preview", () => {
      const result = formatToolOutputForSidebar("", {
        toolName: "write",
        args: {
          path: "docs/notes.md",
          content: "line one\nline two",
        },
      });

      expect(result).toContain("Write Result");
      expect(result).toContain("docs/notes.md");
      expect(result).toContain("Content Preview");
      expect(result).toContain("line one");
    });

    it("formats browser actions with target and result", () => {
      const result = formatToolOutputForSidebar("snapshot completed", {
        toolName: "browser",
        args: {
          action: "snapshot",
          targetUrl: "https://example.com",
        },
      });

      expect(result).toContain("Browser Action");
      expect(result).toContain("snapshot");
      expect(result).toContain("https://example.com");
      expect(result).toContain("Result");
    });

    it("formats messaging actions for slack/discord tools", () => {
      const result = formatToolOutputForSidebar("sent", {
        toolName: "discord",
        args: {
          action: "sendMessage",
          channelId: "123",
          content: "hello",
        },
      });

      expect(result).toContain("Discord Action");
      expect(result).toContain("sendMessage");
      expect(result).toContain("123");
      expect(result).toContain("Message Preview");
    });

    it("formats nodes actions with device metadata", () => {
      const result = formatToolOutputForSidebar("captured", {
        toolName: "nodes",
        args: {
          action: "camera_snap",
          nodeId: "android-01",
          durationMs: 1200,
        },
      });

      expect(result).toContain("Node Action");
      expect(result).toContain("camera_snap");
      expect(result).toContain("android-01");
      expect(result).toContain("Duration");
    });

    it("formats gateway actions with reason and delay", () => {
      const result = formatToolOutputForSidebar("scheduled", {
        toolName: "gateway",
        args: {
          action: "restart",
          reason: "config apply",
          delayMs: 1500,
        },
      });

      expect(result).toContain("Gateway Action");
      expect(result).toContain("restart");
      expect(result).toContain("config apply");
      expect(result).toContain("Delay");
    });
  });

  describe("getTruncatedPreview", () => {
    it("returns short text unchanged", () => {
      const input = "Short text";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Short text");
    });

    it("truncates text longer than max chars", () => {
      const input = "a".repeat(150);
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 chars + ellipsis
      expect(result.endsWith("\u2026")).toBe(true);
    });

    it("truncates to max lines", () => {
      const input = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
      const result = getTruncatedPreview(input);

      expect(result).toBe(`Line 1\nLine 2\u2026`);
    });

    it("adds ellipsis when lines are truncated", () => {
      const input = "Line 1\nLine 2\nLine 3";
      const result = getTruncatedPreview(input);

      expect(result.endsWith("\u2026")).toBe(true);
    });

    it("does not add ellipsis when all lines fit", () => {
      const input = "Line 1\nLine 2";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Line 1\nLine 2");
      expect(result.endsWith("\u2026")).toBe(false);
    });

    it("handles single line within limits", () => {
      const input = "Single line";
      const result = getTruncatedPreview(input);

      expect(result).toBe("Single line");
    });

    it("handles empty string", () => {
      const result = getTruncatedPreview("");
      expect(result).toBe("");
    });

    it("truncates by chars even within line limit", () => {
      const longLine = "x".repeat(80);
      const input = `${longLine}\n${longLine}`;
      const result = getTruncatedPreview(input);

      expect(result.length).toBe(101); // 100 + ellipsis
      expect(result.endsWith("\u2026")).toBe(true);
    });
  });
});
