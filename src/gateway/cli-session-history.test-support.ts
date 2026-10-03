import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readClaudeCliSessionMessagesAsync } from "./cli-session-history.claude-snapshot.js";

export function cliMeta(externalId: string, cliSessionId: string | null = "session-1") {
  return {
    importedFrom: "claude-cli",
    externalId,
    ...(cliSessionId === null ? {} : { cliSessionId }),
  };
}

export function answer(
  timestamp?: number,
  externalId?: string,
  cliSessionId: string | null = "session-1",
) {
  return {
    role: "assistant",
    content: "Repeated answer",
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(externalId === undefined ? {} : { __openclaw: cliMeta(externalId, cliSessionId) }),
  };
}

export function boundEntry(sessionId: string): SessionEntry {
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId } },
  };
}

export function receipt(
  prompt: string,
  localSessionId = "openclaw-session",
): CliSessionReseedReceipt {
  return {
    version: 1,
    promptHash: hashCliReseedPrompt(prompt),
    localSessionId,
    userTurnDisposition: "persisted",
  };
}

export function user(content: unknown, timestamp?: number, meta?: Record<string, unknown>) {
  return {
    role: "user",
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(meta ? { __openclaw: meta } : {}),
  };
}

export function claudeUser(content: unknown, fields: Record<string, unknown> = {}) {
  return { type: "user", ...fields, message: { role: "user", content } };
}

export function createClaudeTextHistoryLines(
  entries: Array<{ content: string; role: "assistant" | "user"; uuid: string }>,
): string {
  return entries
    .map((entry, index) =>
      JSON.stringify({
        type: entry.role,
        uuid: entry.uuid,
        timestamp: new Date(Date.parse("2026-03-26T16:29:54.800Z") + index).toISOString(),
        message: { role: entry.role, content: entry.content },
      }),
    )
    .join("\n");
}

type ClaudeHistoryReadOptions = Omit<
  Parameters<typeof readClaudeCliSessionMessagesAsync>[0],
  "cliSessionId" | "homeDir"
>;

export async function withClaudeProjectsDir<T>(
  run: (params: {
    homeDir: string;
    sessionId: string;
    filePath: string;
    readMessages: (
      options?: ClaudeHistoryReadOptions,
    ) => ReturnType<typeof readClaudeCliSessionMessagesAsync>;
  }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  try {
    return await withEnvAsync({ HOME: homeDir }, () =>
      run({
        homeDir,
        sessionId,
        filePath,
        readMessages: (options) =>
          readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir, ...options }),
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function buildLegacyReseedPrompt(current = "current"): string {
  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    "User: previous",
    "</conversation_history>",
    "",
    "<next_user_message>",
    current,
    "</next_user_message>",
  ].join("\n");
}

function createClaudeHistoryLines(sessionId: string) {
  return [
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-03-26T16:29:54.722Z",
      sessionId,
      content: "[Thu 2026-03-26 16:29 GMT] Reply with exactly: AGENT CLI OK.",
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-1",
      timestamp: "2026-03-26T16:29:54.800Z",
      message: {
        role: "user",
        content:
          'Sender: ⟦openclaw:ctx⟧\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-1",
      timestamp: "2026-03-26T16:29:55.500Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello from Claude" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 22,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-03-26T16:29:56.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "Bash",
            input: {
              command: "pwd",
            },
          },
        ],
        stop_reason: "tool_use",
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "user-2",
      timestamp: "2026-03-26T16:29:56.400Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: "/tmp/demo",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: "ignored",
    }),
  ].join("\n");
}
