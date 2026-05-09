import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  resetReplyRunSession,
  setAgentRunnerSessionResetTestDeps,
} from "./agent-runner-session-reset.js";
import {
  createTestFollowupRun,
  readTestSessionRow,
  writeTestSessionRow,
} from "./agent-runner.test-fixtures.js";

const refreshQueuedFollowupSessionMock = vi.fn();
const errorMock = vi.fn();

describe("resetReplyRunSession", () => {
  let rootDir = "";
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-run-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = rootDir;
    refreshQueuedFollowupSessionMock.mockReset();
    errorMock.mockReset();
    setAgentRunnerSessionResetTestDeps({
      generateSecureUuid: () => "00000000-0000-0000-0000-000000000123",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      error: errorMock,
    });
  });

  afterEach(async () => {
    setAgentRunnerSessionResetTestDeps();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    previousStateDir = undefined;
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("rotates the session and clears stale runtime and fallback fields", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      modelProvider: "qwencode",
      model: "qwen",
      contextTokens: 123,
      fallbackNoticeSelectedModel: "anthropic/claude",
      fallbackNoticeActiveModel: "openai/gpt",
      fallbackNoticeReason: "rate limit",
      systemPromptReport: {
        source: "run",
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    const sessionStore = { main: sessionEntry };
    const followupRun = createTestFollowupRun();
    await writeTestSessionRow("main", sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    let isNewSession = false;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "compaction failure",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      activeSessionEntry,
      activeSessionStore: sessionStore,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {
        isNewSession = true;
      },
    });

    expect(reset).toBe(true);
    expect(isNewSession).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeReason).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      previousSessionId: "session",
      nextSessionId: activeSessionEntry?.sessionId,
    });
    expect(errorMock).toHaveBeenCalledWith("reset 00000000-0000-0000-0000-000000000123");

    const persisted = readTestSessionRow("main");
    expect(persisted?.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted?.fallbackNoticeReason).toBeUndefined();
  });

  it("rotates from the SQLite row when no in-memory store is available", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      totalTokens: 42,
      compactionCount: 1,
    };
    await writeTestSessionRow("main", sessionEntry);

    const followupRun = createTestFollowupRun();
    let activeSessionEntry: SessionEntry | undefined;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "role ordering",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey: "main",
      queueKey: "main",
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(reset).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(activeSessionEntry?.totalTokens).toBeUndefined();
    expect(activeSessionEntry?.compactionCount).toBe(1);
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    const persisted = readTestSessionRow("main");
    expect(persisted?.sessionId).toBe(activeSessionEntry?.sessionId);
  });

  it("uses the prepared run agent when rotating a SQLite-only session", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
    };
    const sessionKey = "agent:main:main";
    await writeTestSessionRow(sessionKey, sessionEntry, "worker");

    const followupRun = createTestFollowupRun({
      agentId: "worker",
      sessionKey,
    });
    let activeSessionEntry: SessionEntry | undefined;
    const reset = await resetReplyRunSession({
      options: {
        failureLabel: "role ordering",
        buildLogMessage: (next) => `reset ${next}`,
      },
      sessionKey,
      queueKey: sessionKey,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {},
    });

    expect(reset).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(readTestSessionRow(sessionKey, "worker")?.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(readTestSessionRow(sessionKey, "main")).toBeUndefined();
  });
});
