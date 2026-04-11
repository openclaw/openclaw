import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing as codexCliHistoryTesting } from "./cli-session-history.codex.js";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
  readCodexCliSessionMessages,
  readClaudeCliSessionMessages,
  resolveCodexCliSessionFilePath,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.js";
import { sanitizeChatHistoryMessages } from "./server-methods/chat.js";

const ORIGINAL_HOME = process.env.HOME;

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
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
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

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, sessionId, filePath });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

type CodexHistoryEvent = {
  timestamp: string;
  payload: Record<string, unknown>;
};

function createCodexHistoryLines(sessionId: string, events?: CodexHistoryEvent[]) {
  const eventLines = events ?? [
    {
      timestamp: "2026-04-11T07:38:34.000Z",
      payload: {
        type: "user_message",
        message: "Why is the history missing after refresh?",
      },
    },
    {
      timestamp: "2026-04-11T07:38:35.000Z",
      payload: {
        type: "token_count",
      },
    },
    {
      timestamp: "2026-04-11T07:38:36.000Z",
      payload: {
        type: "agent_message",
        message: "The current history view only reads the persisted transcript.",
        phase: "final_answer",
      },
    },
    {
      timestamp: "2026-04-11T07:38:37.000Z",
      payload: {
        type: "task_complete",
      },
    },
  ];
  return [
    JSON.stringify({
      timestamp: "2026-04-11T07:38:33.999Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: "/tmp/demo",
      },
    }),
    ...eventLines.map((event) =>
      JSON.stringify({
        timestamp: event.timestamp,
        type: "event_msg",
        payload: event.payload,
      }),
    ),
  ].join("\n");
}

async function withCodexSessionsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
  options?: { lines?: string },
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "019d7b7a-6bf8-7fb3-8abb-412fb4107f9f";
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "11");
  const filePath = path.join(sessionsDir, `rollout-2026-04-11T15-38-33-${sessionId}.jsonl`);
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(filePath, options?.lines ?? createCodexHistoryLines(sessionId), "utf-8");
  process.env.HOME = homeDir;
  try {
    return await run({ homeDir, sessionId, filePath });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("cli session history", () => {
  afterEach(() => {
    codexCliHistoryTesting.resetCodexCliSessionPathCacheForTests();
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveClaudeCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[Thu 2026-03-26 16:29 GMT] hi"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 22,
        },
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: sessionId,
        },
      });
      expect(messages[2]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "toolcall",
            id: "toolu_123",
            name: "Bash",
            arguments: {
              command: "pwd",
            },
          },
          {
            type: "tool_result",
            name: "Bash",
            content: "/tmp/demo",
            tool_use_id: "toolu_123",
          },
        ],
      });
    });
  });

  it("reads codex-cli session messages from the Codex sessions store", async () => {
    await withCodexSessionsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "Why is the history missing after refresh?",
        __openclaw: {
          importedFrom: "codex-cli",
          cliSessionId: sessionId,
        },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        provider: "codex-cli",
        phase: "final_answer",
        content: [
          { type: "text", text: "The current history view only reads the persisted transcript." },
        ],
        __openclaw: {
          importedFrom: "codex-cli",
          cliSessionId: sessionId,
          phase: "final_answer",
        },
      });
    });
  });

  it("keeps the final codex reply when commentary shares a timestamp", async () => {
    await withCodexSessionsDir(
      async ({ homeDir, sessionId }) => {
        const rawMessages = augmentChatHistoryWithCliSessionImports({
          entry: {
            sessionId: "openclaw-session",
            updatedAt: Date.now(),
            cliSessionBindings: {
              "codex-cli": {
                sessionId,
              },
            },
          },
          provider: "codex-cli",
          localMessages: [],
          homeDir,
        });
        expect(rawMessages).toHaveLength(2);
        const visibleMessages = sanitizeChatHistoryMessages(rawMessages, 4_000);
        expect(visibleMessages).toHaveLength(2);
        expect(visibleMessages[1]).toMatchObject({
          role: "assistant",
          phase: "final_answer",
          content: [
            {
              type: "text",
              text: "The current history view only reads the persisted transcript.",
            },
          ],
        });
      },
      {
        lines: createCodexHistoryLines("019d7b7a-6bf8-7fb3-8abb-412fb4107f9f", [
          {
            timestamp: "2026-04-11T07:38:34.000Z",
            payload: {
              type: "user_message",
              message: "Why is the history missing after refresh?",
            },
          },
          {
            timestamp: "2026-04-11T07:38:35.000Z",
            payload: {
              type: "agent_message",
              message: "I am checking the persisted transcript now.",
              phase: "commentary",
            },
          },
          {
            timestamp: "2026-04-11T07:38:35.000Z",
            payload: {
              type: "agent_message",
              message: "The current history view only reads the persisted transcript.",
              phase: "final_answer",
            },
          },
        ]),
      },
    );
  });

  it("merges all bound CLI histories when local transcript is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-history-merge-"));
    const homeDir = path.join(root, "home");
    const originalHome = process.env.HOME;
    const claudeSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
    const codexSessionId = "019d7b7a-6bf8-7fb3-8abb-412fb4107f9f";
    const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    const codexSessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "11");
    await fs.mkdir(claudeProjectsDir, { recursive: true });
    await fs.mkdir(codexSessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeProjectsDir, `${claudeSessionId}.jsonl`),
      createClaudeHistoryLines(claudeSessionId),
      "utf-8",
    );
    await fs.writeFile(
      path.join(codexSessionsDir, `rollout-2026-04-11T15-38-33-${codexSessionId}.jsonl`),
      createCodexHistoryLines(codexSessionId),
      "utf-8",
    );
    process.env.HOME = homeDir;
    try {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId: claudeSessionId,
            },
            "codex-cli": {
              sessionId: codexSessionId,
            },
          },
        },
        provider: "codex-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(5);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { importedFrom: "claude-cli", cliSessionId: claudeSessionId },
      });
      expect(messages[3]).toMatchObject({
        role: "user",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
      expect(messages[4]).toMatchObject({
        role: "assistant",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not re-import CLI history when reset suppresses old CLI backfill", async () => {
    await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "fresh-session",
          updatedAt: Date.now(),
          suppressCliHistoryImport: true,
          cliSessionBindings: {
            "codex-cli": {
              sessionId,
            },
          },
        },
        provider: "codex-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toEqual([]);
    });
  });

  it("imports codex user content from text elements and attachments", async () => {
    await withCodexSessionsDir(
      async ({ homeDir, sessionId }) => {
        const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          role: "user",
          content: [
            { type: "text", text: "Compare these inputs." },
            { type: "image", mimeType: "image/png", data: "QUJD" },
            { type: "text", text: "[Local image attachment: before.png]" },
          ],
          __openclaw: {
            importedFrom: "codex-cli",
            cliSessionId: sessionId,
          },
        });
      },
      {
        lines: createCodexHistoryLines("019d7b7a-6bf8-7fb3-8abb-412fb4107f9f", [
          {
            timestamp: "2026-04-11T07:38:34.000Z",
            payload: {
              type: "user_message",
              text_elements: [{ text: "Compare these inputs." }],
              images: [{ mimeType: "image/png", data: "QUJD" }],
              local_images: [{ path: "/tmp/screenshots/before.png" }],
            },
          },
          {
            timestamp: "2026-04-11T07:38:36.000Z",
            payload: {
              type: "agent_message",
              message: "I can compare the inline image and the local attachment.",
              phase: "final_answer",
            },
          },
        ]),
      },
    );
  });

  it("returns an empty import when a cached codex file disappears before read", async () => {
    await withCodexSessionsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      await fs.rm(filePath, { force: true });
      expect(readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir })).toEqual([]);
    });
  });

  it("ignores non-event Codex transcript records while importing event messages", async () => {
    const sessionId = "019d7b7a-6bf8-7fb3-8abb-412fb4107f9f";
    await withCodexSessionsDir(
      async ({ homeDir }) => {
        const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          role: "user",
          content: "Why is the history missing after refresh?",
        });
        expect(messages[1]).toMatchObject({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The current history view only reads the persisted transcript.",
            },
          ],
        });
      },
      {
        lines: [
          createCodexHistoryLines(sessionId),
          JSON.stringify({
            timestamp: "2026-04-11T07:38:38.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Ignored response item." }],
              phase: "final_answer",
            },
          }),
        ].join("\n"),
      },
    );
  });

  it("isolates the codex session path cache by home directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-cache-"));
    const sessionId = "same-session-id";
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    const fileA = path.join(
      homeA,
      ".codex",
      "sessions",
      "2026",
      "04",
      "11",
      `rollout-2026-04-11T15-38-33-${sessionId}.jsonl`,
    );
    const fileB = path.join(
      homeB,
      ".codex",
      "sessions",
      "2026",
      "04",
      "11",
      `rollout-2026-04-11T15-38-34-${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(fileA), { recursive: true });
    await fs.mkdir(path.dirname(fileB), { recursive: true });
    await fs.writeFile(
      fileA,
      createCodexHistoryLines(sessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from home A",
          },
        },
      ]),
      "utf-8",
    );
    await fs.writeFile(
      fileB,
      createCodexHistoryLines(sessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from home B",
          },
        },
      ]),
      "utf-8",
    );
    try {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir: homeA })).toBe(
        fileA,
      );
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir: homeB })).toBe(
        fileB,
      );
      const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir: homeB });
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "Loaded from home B",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("bounds the codex session path cache", async () => {
    const previousCacheCap = codexCliHistoryTesting.maxCodexCliSessionPathCacheEntries;
    codexCliHistoryTesting.setMaxCodexCliSessionPathCacheEntriesForTests(2);

    try {
      await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
        expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBeTruthy();
      });
      await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
        expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBeTruthy();
      });
      await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
        expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBeTruthy();
      });

      expect(codexCliHistoryTesting.codexCliSessionPathCacheSize).toBeLessThanOrEqual(2);
    } finally {
      codexCliHistoryTesting.setMaxCodexCliSessionPathCacheEntriesForTests(previousCacheCap);
    }
  });

  it("deduplicates imported messages against similar local transcript entries", () => {
    const localMessages = [
      {
        role: "user",
        content: "hi",
        timestamp: Date.parse("2026-03-26T16:29:54.900Z"),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.700Z"),
      },
    ];
    const importedMessages = [
      {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from Claude" }],
        timestamp: Date.parse("2026-03-26T16:29:55.500Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "assistant-1",
          cliSessionId: "session-1",
        },
      },
      {
        role: "user",
        content: "[Thu 2026-03-26 16:31 GMT] follow-up",
        timestamp: Date.parse("2026-03-26T16:31:00.000Z"),
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "user-2",
          cliSessionId: "session-1",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({
      role: "user",
      __openclaw: {
        importedFrom: "claude-cli",
        externalId: "user-2",
      },
    });
  });

  it("augments chat history when a session has a claude-cli binding", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("falls back to legacy cliSessionIds when bindings are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionIds: {
            "claude-cli": sessionId,
          },
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("falls back to legacy claudeCliSessionId when newer fields are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          claudeCliSessionId: sessionId,
        },
        provider: "claude-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId },
      });
    });
  });

  it("augments chat history when a session has a codex-cli binding", async () => {
    await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
          cliSessionBindings: {
            "codex-cli": {
              sessionId,
            },
          },
        },
        provider: "codex-cli",
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { cliSessionId: sessionId, importedFrom: "codex-cli" },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { cliSessionId: sessionId, importedFrom: "codex-cli" },
      });
    });
  });
});
