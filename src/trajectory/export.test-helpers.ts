import fs from "node:fs";
import path from "node:path";
import type { Message, Usage } from "openclaw/plugin-sdk/llm";

const zeroCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const emptyUsage: Usage = { ...zeroCounts, totalTokens: 0, cost: { ...zeroCounts, total: 0 } };
const textContent = (text: string): [{ type: "text"; text: string }] => [{ type: "text", text }];

export function userMessage(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

export function assistantMessage(
  content: Extract<Message, { role: "assistant" }>["content"],
): Message {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolResultMessage(text: string): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: textContent(text),
    isError: false,
    timestamp: 3,
  };
}

function sessionHeader(workspaceDir: string) {
  return {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
  };
}

function messageEntry(id: string, parentId: string | null, message: Message, second = 41) {
  return { type: "message", id, parentId, timestamp: `2026-04-01T05:46:${second}.000Z`, message };
}

function writeEntries(sessionFile: string, entries: readonly unknown[]): void {
  fs.writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function readCall(filePath: string): Message {
  return assistantMessage([
    { type: "toolCall", id: "call_1", name: "read", arguments: { filePath } },
  ]);
}

export function simpleSessionEntries(
  workspaceDir: string,
  params: { userEntryTimestamp?: string | number; userMessage?: Message } = {},
) {
  return [
    sessionHeader(workspaceDir),
    {
      ...messageEntry("entry-user", null, params.userMessage ?? userMessage("hello"), 40),
      timestamp: params.userEntryTimestamp ?? "2026-04-01T05:46:40.000Z",
    },
    messageEntry("entry-assistant", "entry-user", assistantMessage(textContent("done"))),
  ];
}

export function writeSimpleSessionFile(
  sessionFile: string,
  params: Parameters<typeof simpleSessionEntries>[1] = {},
): void {
  writeEntries(sessionFile, simpleSessionEntries(path.dirname(sessionFile), params));
}

export function writeToolCallOnlySessionFile(sessionFile: string): void {
  writeEntries(sessionFile, [
    sessionHeader(path.dirname(sessionFile)),
    messageEntry("entry-assistant", null, readCall("README.md")),
  ]);
}

export function toolCallSessionEntries(workspaceDir: string, toolResultText = "README contents") {
  return [
    { ...sessionHeader(workspaceDir), title: "Trajectory Test" },
    messageEntry("entry-user", null, userMessage("hello"), 40),
    messageEntry(
      "entry-tool-call",
      "entry-user",
      readCall(path.join(workspaceDir, "skills", "weather", "SKILL.md")),
    ),
    messageEntry("entry-tool-result", "entry-tool-call", toolResultMessage(toolResultText), 42),
    messageEntry("entry-assistant", "entry-tool-result", assistantMessage(textContent("done")), 43),
  ];
}

export function writeToolCallSessionFile(
  sessionFile: string,
  toolResultText = "README contents",
): void {
  writeEntries(sessionFile, toolCallSessionEntries(path.dirname(sessionFile), toolResultText));
}
