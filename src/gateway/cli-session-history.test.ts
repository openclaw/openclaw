import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexCliHistoryTesting } from "./cli-session-history.codex.js";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
  readClaudeCliFallbackSeed,
  readCodexCliSessionMessages,
  readClaudeCliSessionMessages,
  resolveCodexCliSessionFilePath,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.js";
import { sanitizeChatHistoryMessages } from "./server-methods/chat.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;

type ClaudeCliFallbackSeed = NonNullable<ReturnType<typeof readClaudeCliFallbackSeed>>;

function requireFallbackSeed(
  seed: ReturnType<typeof readClaudeCliFallbackSeed>,
  label: string,
): ClaudeCliFallbackSeed {
  if (!seed) {
    throw new Error(`expected ${label} fallback seed`);
  }
  return seed;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
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
  delete process.env.CODEX_HOME;
  try {
    return await run({ homeDir, sessionId, filePath });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    if (ORIGINAL_CODEX_HOME === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
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
    if (ORIGINAL_CODEX_HOME === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
    }
  });

  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveClaudeCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expectFields(messages[0], {
        role: "user",
      });
      expect(String(messages[0]?.content)).toContain("[Thu 2026-03-26 16:29 GMT] hi");
      expectFields(messages[0]?.["__openclaw"], {
        importedFrom: "claude-cli",
        externalId: "user-1",
        cliSessionId: sessionId,
      });
      expectFields(messages[1], {
        role: "assistant",
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
      });
      expectFields(messages[1]?.usage, {
        input: 11,
        output: 7,
        cacheRead: 22,
      });
      expectFields(messages[1]?.["__openclaw"], {
        importedFrom: "claude-cli",
        externalId: "assistant-1",
        cliSessionId: sessionId,
      });
      expectFields(messages[2], {
        role: "assistant",
      });
      expect(messages[2]?.content).toEqual([
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
      ]);
    });
  });

  it("rejects path-like Claude CLI session ids", async () => {
    await withClaudeProjectsDir(async ({ homeDir }) => {
      expect(
        resolveClaudeCliSessionFilePath({ cliSessionId: "../outside", homeDir }),
      ).toBeUndefined();
      expect(
        resolveClaudeCliSessionFilePath({ cliSessionId: "nested/session", homeDir }),
      ).toBeUndefined();
      expect(
        resolveClaudeCliSessionFilePath({ cliSessionId: "nested\\session", homeDir }),
      ).toBeUndefined();
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

  it("resolves codex-cli session messages from CODEX_HOME before HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-home-history-"));
    const homeDir = path.join(root, "home");
    const codexHome = path.join(root, "custom-codex-home");
    const sessionId = "019d7b7a-6bf8-7fb3-8abb-412fb4107f9f";
    const sessionsDir = path.join(codexHome, "sessions", "2026", "04", "11");
    const filePath = path.join(sessionsDir, `rollout-2026-04-11T15-38-33-${sessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(filePath, createCodexHistoryLines(sessionId), "utf-8");
    process.env.HOME = homeDir;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId })).toBe(filePath);
      const messages = readCodexCliSessionMessages({ cliSessionId: sessionId });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: {
          importedFrom: "codex-cli",
          cliSessionId: sessionId,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("merges all bound CLI histories when provider is unknown and local transcript is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-history-merge-"));
    const homeDir = path.join(root, "home");
    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
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
    delete process.env.CODEX_HOME;
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
        provider: undefined,
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
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("scopes empty-transcript imports to the active provider when one is resolved", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-history-scope-"));
    const homeDir = path.join(root, "home");
    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
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
    delete process.env.CODEX_HOME;
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
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
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

  it("does not merge stale CLI history into reset sessions with local transcript entries", async () => {
    await withCodexSessionsDir(async ({ homeDir, sessionId }) => {
      const localMessages = [
        {
          role: "user",
          content: "fresh local question",
          timestamp: Date.parse("2026-04-11T08:00:00.000Z"),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "fresh local answer" }],
          timestamp: Date.parse("2026-04-11T08:00:01.000Z"),
        },
      ];
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
        localMessages,
        homeDir,
      });
      expect(messages).toEqual(localMessages);
    });
  });

  it("keeps reset suppression scoped to preserved providers after another provider rebounds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-history-suppress-scope-"));
    const homeDir = path.join(root, "home");
    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
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
    delete process.env.CODEX_HOME;
    try {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          sessionId: "fresh-session",
          updatedAt: Date.now(),
          suppressCliHistoryImport: true,
          suppressCliHistoryImportProviders: ["claude-cli"],
          cliSessionBindings: {
            "claude-cli": {
              sessionId: claudeSessionId,
            },
            "codex-cli": {
              sessionId: codexSessionId,
            },
          },
        },
        provider: undefined,
        localMessages: [],
        homeDir,
      });
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: "user",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        __openclaw: { importedFrom: "codex-cli", cliSessionId: codexSessionId },
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("prefers the newest matching codex transcript file for the same session id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-newest-"));
    const homeDir = path.join(root, "home");
    const sessionId = "same-session-id";
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "11");
    const olderFile = path.join(sessionsDir, `rollout-2026-04-11T15-38-33-${sessionId}.jsonl`);
    const newerFile = path.join(sessionsDir, `rollout-2026-04-11T15-38-34-${sessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      olderFile,
      createCodexHistoryLines(sessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from the older transcript",
          },
        },
      ]),
      "utf-8",
    );
    await fs.writeFile(
      newerFile,
      createCodexHistoryLines(sessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from the newer transcript",
          },
        },
      ]),
      "utf-8",
    );
    await fs.utimes(
      olderFile,
      new Date("2026-04-11T07:38:33.000Z"),
      new Date("2026-04-11T07:38:33.000Z"),
    );
    await fs.utimes(
      newerFile,
      new Date("2026-04-11T07:38:34.000Z"),
      new Date("2026-04-11T07:38:34.000Z"),
    );

    try {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(newerFile);
      const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "Loaded from the newer transcript",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("re-scans matching codex transcript files before reusing a cached path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-cache-refresh-"));
    const homeDir = path.join(root, "home");
    const sessionId = "same-session-id";
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "11");
    const olderFile = path.join(sessionsDir, `rollout-2026-04-11T15-38-33-${sessionId}.jsonl`);
    const newerFile = path.join(sessionsDir, `rollout-2026-04-11T15-38-34-${sessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      olderFile,
      createCodexHistoryLines(sessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from the older transcript",
          },
        },
      ]),
      "utf-8",
    );
    await fs.utimes(
      olderFile,
      new Date("2026-04-11T07:38:33.000Z"),
      new Date("2026-04-11T07:38:33.000Z"),
    );

    try {
      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(olderFile);

      await fs.writeFile(
        newerFile,
        createCodexHistoryLines(sessionId, [
          {
            timestamp: "2026-04-11T07:38:34.000Z",
            payload: {
              type: "user_message",
              message: "Loaded from the newer transcript",
            },
          },
        ]),
        "utf-8",
      );
      await fs.utimes(
        newerFile,
        new Date("2026-04-11T07:38:34.000Z"),
        new Date("2026-04-11T07:38:34.000Z"),
      );

      expect(resolveCodexCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(newerFile);
      const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "Loaded from the newer transcript",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not match a codex transcript whose session token only shares a suffix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-history-suffix-"));
    const homeDir = path.join(root, "home");
    const requestedSessionId = "abc";
    const otherSessionId = "xabc";
    const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "11");
    const otherFile = path.join(sessionsDir, `rollout-2026-04-11T15-38-33-${otherSessionId}.jsonl`);
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      otherFile,
      createCodexHistoryLines(otherSessionId, [
        {
          timestamp: "2026-04-11T07:38:34.000Z",
          payload: {
            type: "user_message",
            message: "Loaded from the wrong transcript",
          },
        },
      ]),
      "utf-8",
    );

    try {
      expect(
        resolveCodexCliSessionFilePath({ cliSessionId: requestedSessionId, homeDir }),
      ).toBeUndefined();
      expect(readCodexCliSessionMessages({ cliSessionId: requestedSessionId, homeDir })).toEqual(
        [],
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("imports Codex response_item message records while ignoring unsupported records", async () => {
    const sessionId = "019d7b7a-6bf8-7fb3-8abb-412fb4107f9f";
    await withCodexSessionsDir(
      async ({ homeDir }) => {
        const messages = readCodexCliSessionMessages({ cliSessionId: sessionId, homeDir });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          role: "user",
          content: "Response item question",
          __openclaw: {
            importedFrom: "codex-cli",
            cliSessionId: sessionId,
            externalId: "response_item:2026-04-11T07:38:34.000Z:0",
          },
        });
        expect(messages[1]).toMatchObject({
          role: "assistant",
          provider: "codex-cli",
          phase: "final_answer",
          content: [
            {
              type: "text",
              text: "Response item answer",
            },
          ],
          __openclaw: {
            importedFrom: "codex-cli",
            cliSessionId: sessionId,
            externalId: "response_item:2026-04-11T07:38:36.000Z:1",
            phase: "final_answer",
          },
        });
      },
      {
        lines: [
          JSON.stringify({
            timestamp: "2026-04-11T07:38:33.999Z",
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: "/tmp/demo",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-11T07:38:34.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Response item question" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-11T07:38:35.000Z",
            type: "response_item",
            payload: {
              type: "reasoning",
              content: [{ type: "summary_text", text: "internal reasoning" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-11T07:38:36.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Response item answer" }],
              phase: "final_answer",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-11T07:38:37.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "hidden instructions" }],
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
    expectFields(merged[2], {
      role: "user",
    });
    expectFields(readRecord(merged[2])["__openclaw"], {
      importedFrom: "claude-cli",
      externalId: "user-2",
    });
  });

  it("does not dedupe external ids from different imported sessions", () => {
    const localMessages = [
      {
        role: "user",
        content: "hello from first session",
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "same-id",
          cliSessionId: "session-1",
        },
      },
    ];
    const importedMessages = [
      {
        role: "user",
        content: "hello from second session",
        __openclaw: {
          importedFrom: "claude-cli",
          externalId: "same-id",
          cliSessionId: "session-2",
        },
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged).toHaveLength(2);
  });

  it("keeps untimestamped local messages in place when importing timestamped history", () => {
    const localMessages = [{ role: "user", content: "local without timestamp" }];
    const importedMessages = [
      { role: "assistant", content: "older imported", timestamp: Date.parse("2020-01-01") },
    ];

    const merged = mergeImportedChatHistoryMessages({ localMessages, importedMessages });
    expect(merged[0]).toBe(localMessages[0]);
    expect(merged[1]).toBe(importedMessages[0]);
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
      expectFields(messages[0], {
        role: "user",
      });
      expectFields(readRecord(messages[0])["__openclaw"], { cliSessionId: sessionId });
    });
  });

  it("augments anthropic-routed chat history when a Claude CLI binding has local messages", async () => {
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
        provider: "anthropic",
        localMessages: [
          {
            role: "assistant",
            content: "local assistant turn",
            timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
          },
        ],
        homeDir,
      });

      expect(messages).toHaveLength(4);
      expect(
        messages.some((message) => {
          const record = readRecord(message);
          return record.role === "assistant" && record.content === "local assistant turn";
        }),
      ).toBe(true);
      const importedUser = messages.find((message) => {
        const record = readRecord(message);
        return (
          record.role === "user" &&
          (record["__openclaw"] as { cliSessionId?: unknown } | undefined)?.cliSessionId ===
            sessionId
        );
      });
      if (!importedUser) {
        throw new Error("Expected imported user CLI history message");
      }
    });
  });

  it("does not import stale Claude CLI history for unrelated providers with local messages", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const localMessages = [
        {
          role: "assistant",
          content: "local OpenAI turn",
          timestamp: Date.parse("2026-03-26T16:29:57.000Z"),
        },
      ];
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
        provider: "openai",
        localMessages,
        homeDir,
      });

      expect(messages).toBe(localMessages);
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
      expectFields(messages[1], {
        role: "assistant",
      });
      expectFields(readRecord(messages[1])["__openclaw"], { cliSessionId: sessionId });
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
      expectFields(messages[0], {
        role: "user",
      });
      expectFields(readRecord(messages[0])["__openclaw"], { cliSessionId: sessionId });
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

describe("readClaudeCliFallbackSeed", () => {
  let tmpRoot: string;
  let homeDir: string;
  let projectsDir: string;
  const SESSION_ID = "fallback-seed-session";

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-seed-"));
    homeDir = path.join(tmpRoot, "home");
    projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    await fs.mkdir(projectsDir, { recursive: true });
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function writeJsonl(lines: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    const file = path.join(projectsDir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  }

  it("returns undefined when the Claude session file does not exist", () => {
    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeUndefined();
  });

  it("collects user/assistant turns when the session has never been compacted", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "first user prompt" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "first assistant reply" }],
        },
      },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "second user prompt" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    const fallbackSeed = requireFallbackSeed(seed, "uncompacted session");
    expect(fallbackSeed.summaryText).toBeUndefined();
    expect(fallbackSeed.recentTurns).toHaveLength(3);
    expectFields(fallbackSeed.recentTurns[0], { role: "user" });
    expectFields(fallbackSeed.recentTurns[2], { role: "user" });
  });

  it("uses the explicit /compact summary and drops pre-boundary turns", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "pre-compact user turn excluded from seed" },
      },
      {
        type: "assistant",
        uuid: "a-pre",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "PRE-COMPACT assistant turn" }],
        },
      },
      {
        type: "summary",
        summary: "User asked about deployment; agent recommended a blue-green strategy.",
        leafUuid: "a-pre",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 12345 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "POST-COMPACT user follow-up" },
      },
      {
        type: "assistant",
        uuid: "a-post",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "POST-COMPACT assistant reply" }],
        },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    const fallbackSeed = requireFallbackSeed(seed, "compacted session");
    expect(fallbackSeed.summaryText).toBe(
      "User asked about deployment; agent recommended a blue-green strategy.",
    );
    expect(fallbackSeed.recentTurns).toHaveLength(2);
    const recentText = JSON.stringify(fallbackSeed.recentTurns);
    expect(recentText).toContain("POST-COMPACT user follow-up");
    expect(recentText).toContain("POST-COMPACT assistant reply");
    expect(recentText).not.toContain("PRE-COMPACT");
  });

  it("falls back to compact_boundary content when no explicit summary entry is present", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-pre",
        message: { role: "user", content: "early turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "auto", preTokens: 50000 },
      },
      {
        type: "user",
        uuid: "u-post",
        message: { role: "user", content: "post-boundary user turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    const fallbackSeed = requireFallbackSeed(seed, "compact boundary session");
    // Falls back to the boundary's content so the seed at least labels
    // that compaction happened, instead of replaying nothing.
    expect(fallbackSeed.summaryText).toBe("Conversation compacted");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-boundary user turn");
  });

  it("prefers the most recent summary when the session has been compacted multiple times", async () => {
    await writeJsonl([
      {
        type: "summary",
        summary: "EARLY summary that should be superseded.",
        leafUuid: "x",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "mid-window turn" },
      },
      {
        type: "summary",
        summary: "LATER summary that must win.",
        leafUuid: "y",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        compactMetadata: { trigger: "manual", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "tail turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed?.summaryText).toBe("LATER summary that must win.");
    expect(seed?.recentTurns).toHaveLength(1);
    expect(JSON.stringify(seed?.recentTurns)).toContain("tail turn");
    expect(JSON.stringify(seed?.recentTurns)).not.toContain("mid-window turn");
  });

  it("returns undefined when the session file is empty or has no usable content", async () => {
    await writeJsonl([
      // Sidechain entries are filtered out by the underlying parser.
      {
        type: "user",
        uuid: "u-side",
        isSidechain: true,
        message: { role: "user", content: "sidechain user turn" },
      },
    ]);
    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed).toBeUndefined();
  });

  it("rejects path-like session ids instead of escaping the Claude projects tree", () => {
    const seed = readClaudeCliFallbackSeed({ cliSessionId: "../escape" });
    expect(seed).toBeUndefined();
  });

  it("falls back to the latest boundary content when a newer compaction has no summary", async () => {
    await writeJsonl([
      { type: "summary", summary: "FIRST compact summary", leafUuid: "x" },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (1)",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "user",
        uuid: "u-mid",
        message: { role: "user", content: "post-first-compact turn" },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted (2)",
        compactMetadata: { trigger: "auto", preTokens: 2000 },
      },
      {
        type: "user",
        uuid: "u-tail",
        message: { role: "user", content: "post-second-compact turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    const fallbackSeed = requireFallbackSeed(seed, "latest boundary session");
    expect(fallbackSeed.summaryText).toBe("Conversation compacted (2)");
    expect(fallbackSeed.summaryText).not.toBe("FIRST compact summary");
    expect(fallbackSeed.recentTurns).toHaveLength(1);
    expect(JSON.stringify(fallbackSeed.recentTurns)).toContain("post-second-compact turn");
  });

  it("uses a trailing summary that has no following compact_boundary marker", async () => {
    await writeJsonl([
      {
        type: "user",
        uuid: "u-1",
        message: { role: "user", content: "earlier turn" },
      },
      { type: "summary", summary: "trailing summary without boundary", leafUuid: "x" },
      {
        type: "user",
        uuid: "u-2",
        message: { role: "user", content: "later turn" },
      },
    ]);

    const seed = readClaudeCliFallbackSeed({ cliSessionId: SESSION_ID });
    expect(seed?.summaryText).toBe("trailing summary without boundary");
  });
});
