import { describe, expect, it } from "vitest";
import {
  clampOneLine,
  extractTraceMessagesFromSessionLine,
  parseFeishuSessionTraceArgs,
  redactTraceText,
  summarizeToolCall,
} from "./feishu-session-trace-shared.js";

describe("feishu session trace shared helpers", () => {
  it("parses required args and optional flags", () => {
    expect(
      parseFeishuSessionTraceArgs([
        "--session-file",
        "/tmp/session.jsonl",
        "--target",
        "chat:oc_xxx",
        "--account",
        "default",
        "--min-interval-ms",
        "3000",
        "--max-len",
        "180",
        "--dry-run",
      ]),
    ).toEqual({
      sessionFile: "/tmp/session.jsonl",
      target: "chat:oc_xxx",
      account: "default",
      minIntervalMs: 3000,
      maxLen: 180,
      dryRun: true,
    });
  });

  it("rejects missing required args", () => {
    expect(() => parseFeishuSessionTraceArgs(["--target", "chat:oc_xxx"])).toThrow(
      "Missing --session-file",
    );
    expect(() => parseFeishuSessionTraceArgs(["--session-file", "/tmp/x.jsonl"])).toThrow(
      "Missing --target",
    );
  });

  it("clamps multi-line text to one line", () => {
    expect(clampOneLine("hello\nworld", 40)).toBe("hello world");
  });

  it("redacts obvious secrets", () => {
    expect(redactTraceText("OPENAI_API_KEY=sk-1234567890abcdef")).toBe("OPENAI_API_KEY=***");
    expect(redactTraceText("ghp_1234567890abcdef")).toBe("ghp_***");
  });

  it("summarizes supported tool calls", () => {
    expect(summarizeToolCall("read", { path: "/tmp/a.txt" })).toBe("Read file /tmp/a.txt");
    expect(summarizeToolCall("exec", { command: "pnpm test" })).toBe("Run command pnpm test");
    expect(summarizeToolCall("todoWrite", {})).toBe("Update todo list");
    expect(summarizeToolCall("unknown_tool", {})).toBeNull();
  });

  it("extracts summaries from assistant tool-call session lines", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path: "/tmp/a.txt" },
          },
          {
            type: "text",
            text: "done",
          },
          {
            type: "toolCall",
            name: "webSearch",
            arguments: { query: "openclaw" },
          },
        ],
      },
    });

    expect(extractTraceMessagesFromSessionLine(line)).toEqual([
      "Read file /tmp/a.txt",
      "Search web openclaw",
    ]);
  });
});
