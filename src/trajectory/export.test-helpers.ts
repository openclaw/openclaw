import fs from "node:fs";
import path from "node:path";
import type { Message, Usage } from "openclaw/plugin-sdk/llm";

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function userMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
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

function toolResultMessage(content: Extract<Message, { role: "toolResult" }>["content"]): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content,
    isError: false,
    timestamp: 3,
  };
}

export function simpleSessionEntries(
  workspaceDir: string,
  params: { userEntryTimestamp?: string | number; userMessage?: Message } = {},
) {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
  };
  const userEntry = {
    type: "message",
    id: "entry-user",
    parentId: null,
    timestamp: params.userEntryTimestamp ?? "2026-04-01T05:46:40.000Z",
    message: params.userMessage ?? userMessage("hello"),
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: "entry-user",
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([{ type: "text", text: "done" }]),
  };
  return [header, userEntry, assistantEntry];
}

export function writeSimpleSessionFile(
  sessionFile: string,
  params: Parameters<typeof simpleSessionEntries>[1] = {},
): void {
  fs.writeFileSync(
    sessionFile,
    `${simpleSessionEntries(path.dirname(sessionFile), params)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8",
  );
}

export function writeToolCallOnlySessionFile(sessionFile: string): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: path.dirname(sessionFile),
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: null,
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { filePath: "README.md" },
      },
    ]),
  };
  fs.writeFileSync(
    sessionFile,
    `${[header, assistantEntry].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

export function toolCallSessionEntries(workspaceDir: string, toolResultText = "README contents") {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
    title: "Trajectory Test",
  };
  return [
    header,
    {
      type: "message",
      id: "entry-user",
      parentId: null,
      timestamp: "2026-04-01T05:46:40.000Z",
      message: userMessage("hello"),
    },
    {
      type: "message",
      id: "entry-tool-call",
      parentId: "entry-user",
      timestamp: "2026-04-01T05:46:41.000Z",
      message: assistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: {
            filePath: path.join(workspaceDir, "skills", "weather", "SKILL.md"),
          },
        },
      ]),
    },
    {
      type: "message",
      id: "entry-tool-result",
      parentId: "entry-tool-call",
      timestamp: "2026-04-01T05:46:42.000Z",
      message: toolResultMessage([{ type: "text", text: toolResultText }]),
    },
    {
      type: "message",
      id: "entry-assistant",
      parentId: "entry-tool-result",
      timestamp: "2026-04-01T05:46:43.000Z",
      message: assistantMessage([{ type: "text", text: "done" }]),
    },
  ];
}

export function writeToolCallSessionFile(
  sessionFile: string,
  toolResultText = "README contents",
): void {
  fs.writeFileSync(
    sessionFile,
    `${toolCallSessionEntries(path.dirname(sessionFile), toolResultText)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8",
  );
}
