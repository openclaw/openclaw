import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampOneLine,
  extractTraceMessagesFromSessionLine,
  followAppendedFileLines,
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
    expect(redactTraceText("Run command curl sk-1234567890abcdef")).toBe("Run command curl sk-***");
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

  it("accepts legacy content block types and top-level tool call payloads", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            name: "edit",
            input: { path: "/tmp/b.txt" },
          },
        ],
        tool_calls: [
          {
            function: {
              name: "exec",
              arguments: JSON.stringify({ command: "pnpm test" }),
            },
          },
        ],
      },
    });

    expect(extractTraceMessagesFromSessionLine(line)).toEqual([
      "Edit file /tmp/b.txt",
      "Run command pnpm test",
    ]);
  });

  it("parses stringified arguments on top-level function_call payloads", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        function_call: {
          name: "exec",
          arguments: JSON.stringify({ command: "pnpm build" }),
        },
      },
    });

    expect(extractTraceMessagesFromSessionLine(line)).toEqual(["Run command pnpm build"]);
  });

  it("follows appended lines without relying on tail", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-trace-"));
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, "old\n");

    const controller = new AbortController();
    const lines = followAppendedFileLines(file, {
      pollMs: 10,
      signal: controller.signal,
    });

    const firstLine = lines.next();
    await fs.appendFile(file, "new-one\n");
    await expect(firstLine).resolves.toEqual({ done: false, value: "new-one" });

    const secondLine = lines.next();
    await fs.appendFile(file, "new");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.appendFile(file, "-two\r\n");
    await expect(secondLine).resolves.toEqual({ done: false, value: "new-two" });

    controller.abort();
    await lines.return(undefined);
  });
});
