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

function transcriptParentReference(scope: TranscriptScope): string {
  return `agent-db:${scope.agentId}:transcript_events:${scope.sessionId}`;
}

function readSessionEntries(scope: TranscriptScope) {
  return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("TranscriptSessionManager", () => {
  it("exposes create, in-memory, list, continue, and fork through the contract value", async () => {
    await useTempStateDir();
    const memory = SessionManager.inMemory("/tmp/memory-workspace");
    expect(memory.isPersisted()).toBe(false);
    expect(memory.getTranscriptLocator()).toBeUndefined();
    const memoryUserId = memory.appendMessage({
      role: "user",
      content: "in memory",
      timestamp: 1,
    });
    expect(memory.getLeafId()).toBe(memoryUserId);

    const created = SessionManager.create("/tmp/workspace");
    created.appendMessage({ role: "user", content: "persist me", timestamp: 2 });
    const sourceSessionId = created.getSessionId();

    const listed = await SessionManager.list("/tmp/workspace");
    expect(listed.map((session) => session.id)).toContain(sourceSessionId);

    const continued = SessionManager.continueRecent("/tmp/workspace");
    expect(continued.getSessionId()).toBe(sourceSessionId);

    const forked = SessionManager.forkFromSession({
      agentId: "main",
      sessionId: sourceSessionId,
      targetCwd: "/tmp/forked-workspace",
    });
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/forked-workspace",
      parentSession: transcriptParentReference({
        agentId: "main",
        sessionId: sourceSessionId,
      }),
    });
    expect(forked.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "persist me" },
    ]);
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
      sessionId: "locator-session",
    };

    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/workspace",
    });
    sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });

    expect(sessionManager.getSessionId()).toBe("locator-session");
    expect(readSessionEntries(scope)).toMatchObject([
      {
        type: "session",
        id: "locator-session",
        cwd: "/tmp/workspace",
      },
      {
        type: "message",
        message: { role: "user", content: "seed" },
      },
    ]);
  });

  it("creates, branches, lists, and forks default sessions in sqlite", async () => {
    await useTempStateDir();
    const sessionManager = SessionManager.create("/tmp/sqlite-workspace");
    const sessionId = sessionManager.getSessionId();

    const userId = sessionManager.appendMessage({
      role: "user",
      content: "sqlite default",
      timestamp: 3,
    });
    const branchFile = sessionManager.createBranchedSession(userId);
    if (!branchFile) {
      throw new Error("expected branched session");
    }

    const listed = await SessionManager.list("/tmp/sqlite-workspace");
    expect(listed.map((session) => session.id)).toContain(sessionManager.getSessionId());

    const forked = SessionManager.forkFromSession({
      agentId: "main",
      sessionId,
      targetCwd: "/tmp/sqlite-fork",
    });
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/sqlite-fork",
      parentSession: transcriptParentReference({
        agentId: "main",
        sessionId,
      }),
    });
  });

  it("allocates a fresh sqlite session when starting a new persisted session", async () => {
    await useTempStateDir();
    const firstScope = { agentId: "main", sessionId: "first-session" };
    const sessionManager = openTranscriptSessionManagerForSession({
      ...firstScope,
      cwd: "/tmp/workspace",
    });
    sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });

    const secondTranscriptLocator = sessionManager.newSession({ id: "second-session" });
    sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });

    expect(secondTranscriptLocator).toBeTruthy();
    expect(readSessionEntries(firstScope).map((entry) => (entry as { id?: string }).id)).toEqual([
      "first-session",
      expect.any(String),
    ]);
    expect(readSessionEntries({ agentId: "main", sessionId: "second-session" })).toMatchObject([
      { type: "session", id: "second-session" },
      { type: "message", message: { role: "user", content: "second" } },
    ]);
  });

  it("preserves non-main agent scope for sqlite branches and forks", async () => {
    await useTempStateDir();
    const scope = {
      agentId: "qa",
      sessionId: "qa-source-session",
    };
    const sessionManager = openTranscriptSessionManagerForSession({
      ...scope,
      cwd: "/tmp/qa-workspace",
    });
    const userId = sessionManager.appendMessage({
      role: "user",
      content: "qa source",
      timestamp: 4,
    });

    const branchFile = sessionManager.createBranchedSession(userId);
    expect(branchFile).toBeTruthy();

    const forked = SessionManager.forkFromSession({
      ...scope,
      targetCwd: "/tmp/qa-fork",
    });
    expect(forked.getHeader()).toMatchObject({
      cwd: "/tmp/qa-fork",
    });
    expect(readSessionEntries({ agentId: "qa", sessionId: forked.getSessionId() })).toHaveLength(2);
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

  it("removes persisted tail entries through SQLite instead of rewriting JSONL", async () => {
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
