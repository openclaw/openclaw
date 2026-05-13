import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { openTranscriptSessionManagerForSession } from "./session-manager.js";
import { SessionManager } from "./session-transcript-contract.js";

async function useTempStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-session-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

type TranscriptScope = {
  agentId: string;
  sessionId: string;
};

function readSessionEntries(scope: TranscriptScope) {
  return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("TranscriptSessionManager", () => {
  it("exposes explicit SQLite sessions through a named opener and in-memory sessions through the contract value", async () => {
    await useTempStateDir();
    const memory = SessionManager.inMemory("/tmp/memory-workspace");
    expect(memory.isPersisted()).toBe(false);
    expect(memory.getTranscriptScope()).toBeUndefined();
    const memoryUserId = memory.appendMessage({
      role: "user",
      content: "in memory",
      timestamp: 1,
    });
    expect(memory.getLeafId()).toBe(memoryUserId);

    const created = openTranscriptSessionManagerForSession({
      agentId: "main",
      sessionId: "contract-session",
      cwd: "/tmp/workspace",
    });
    created.appendMessage({ role: "user", content: "persist me", timestamp: 2 });
    const sourceSessionId = created.getSessionId();
    expect(created.getTranscriptScope()).toEqual({
      agentId: "main",
      sessionId: sourceSessionId,
    });
  });

  it("opens sqlite transcripts by agent and session scope", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "virtual-session",
    };

    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });

    expect(sessionManager.getSessionId()).toBe("virtual-session");
    expect(readSessionEntries(scope)).toMatchObject([
      {
        type: "session",
        id: "virtual-session",
        cwd: "/tmp/workspace",
      },
    ]);
  });

  it("uses the scoped session id when opening an empty transcript", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "scoped-session",
    };

    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });
    sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });

    expect(sessionManager.getSessionId()).toBe("scoped-session");
    expect(readSessionEntries(scope)).toMatchObject([
      {
        type: "session",
        id: "scoped-session",
        cwd: "/tmp/workspace",
      },
      {
        type: "message",
        message: { role: "user", content: "seed" },
      },
    ]);
  });

  it("persists initial user messages synchronously before the first assistant message", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "session-sync",
    };
    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });

    const afterUser = readSessionEntries(scope);
    expect(afterUser).toHaveLength(2);
    expect(afterUser[1]).toMatchObject({
      type: "message",
      id: userId,
      parentId: null,
      message: { role: "user", content: "hello" },
    });

    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    const reopened = openTranscriptSessionManagerForSession(scope);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([userId, assistantId]);
    expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("selects message parents inside SQLite for stale persisted managers", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "session-atomic-parent",
    };
    const first = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });
    const rootId = first.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const second = openTranscriptSessionManagerForSession(scope);

    const firstReplyId = first.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const staleReplyId = second.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "stale manager" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 3,
    });

    const messages = readSessionEntries(scope).filter(
      (entry): entry is { type: "message"; id: string; parentId: string | null } =>
        Boolean(
          entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message",
        ),
    );
    expect(messages.map((entry) => [entry.id, entry.parentId])).toEqual([
      [rootId, null],
      [firstReplyId, rootId],
      [staleReplyId, firstReplyId],
    ]);
  });

  it("selects metadata-entry parents inside SQLite for stale persisted managers", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "session-atomic-metadata-parent",
    };
    const first = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });
    const rootId = first.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const second = openTranscriptSessionManagerForSession(scope);

    const thinkingId = first.appendThinkingLevelChange("high");
    const modelId = second.appendModelChange("openai", "gpt-5.5");

    const entries = readSessionEntries(scope).filter(
      (entry): entry is { id: string; parentId?: string | null; type: string } =>
        Boolean(
          entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
        ),
    );
    expect(entries.map((entry) => [entry.type, entry.id, entry.parentId])).toEqual([
      ["session", "session-atomic-metadata-parent", undefined],
      ["message", rootId, null],
      ["thinking_level_change", thinkingId, rootId],
      ["model_change", modelId, thinkingId],
    ]);
  });

  it("removes persisted tail entries by replacing SQLite transcript rows", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "session-tail",
    };
    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    const assistantId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "synthetic" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      timestamp: 2,
    });

    expect(
      sessionManager.removeTailEntries((entry) => (entry as { id?: string }).id === assistantId),
    ).toBe(1);

    const reopened = openTranscriptSessionManagerForSession(scope);
    expect(reopened.getEntry(assistantId)).toBeUndefined();
    expect(reopened.getLeafId()).toBe(userId);
    expect(readSessionEntries(scope).map((entry) => (entry as { id?: string }).id)).toEqual([
      "session-tail",
      userId,
    ]);
  });

  it("supports tree, label, name, and branch summary session APIs", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "main",
      sessionId: "session-tree",
    };
    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });
    const rootId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    const childId = sessionManager.appendMessage({ role: "user", content: "child", timestamp: 2 });
    sessionManager.branch(rootId);
    const siblingId = sessionManager.appendMessage({
      role: "user",
      content: "sibling",
      timestamp: 3,
    });
    sessionManager.appendLabelChange(siblingId, "alternate");
    sessionManager.appendSessionInfo("Named session");
    const summaryId = sessionManager.branchWithSummary(childId, "Back to main branch.");

    expect(sessionManager.getChildren(rootId).map((entry) => entry.id)).toEqual([
      childId,
      siblingId,
    ]);
    expect(sessionManager.getLabel(siblingId)).toBe("alternate");
    expect(sessionManager.getSessionName()).toBe("Named session");
    expect(sessionManager.getTree()[0]).toMatchObject({
      entry: { id: rootId },
      children: [{ entry: { id: childId } }, { entry: { id: siblingId }, label: "alternate" }],
    });

    const reopened = openTranscriptSessionManagerForSession(scope);
    expect(reopened.getEntry(summaryId)).toMatchObject({
      type: "branch_summary",
      fromId: childId,
      summary: "Back to main branch.",
    });
  });
});
