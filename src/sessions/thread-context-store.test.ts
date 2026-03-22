import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildThreadContextKey,
  formatThreadContextNote,
  loadThreadContext,
  MAX_THREAD_CONTEXT_ENTRIES,
  resolveThreadContextStorePath,
  saveThreadContext,
  THREAD_CONTEXT_TTL_MS,
  type ThreadContextEntry,
} from "./thread-context-store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-thread-ctx-test-"));
}

describe("buildThreadContextKey", () => {
  it("builds a canonical key from channel/account/chat/threadId", () => {
    expect(
      buildThreadContextKey({ channel: "Slack", accountId: "T123", chatId: "C99", threadId: 42 }),
    ).toBe("slack:t123:c99:42");
  });

  it("uses 'default' when accountId and chatId are missing", () => {
    expect(buildThreadContextKey({ channel: "telegram", threadId: "123" })).toBe(
      "telegram:default:default:123",
    );
  });

  it("normalizes channel to lowercase", () => {
    expect(
      buildThreadContextKey({ channel: "DISCORD", accountId: "A1", chatId: "G1", threadId: "t1" }),
    ).toBe("discord:a1:g1:t1");
  });
});

describe("resolveThreadContextStorePath", () => {
  it("returns a path ending in thread-contexts.json", () => {
    const stateDir = path.join(os.tmpdir(), "test-state-resolve");
    const p = resolveThreadContextStorePath(stateDir);
    expect(p).toBe(path.join(stateDir, "sessions", "thread-contexts.json"));
  });
});

describe("saveThreadContext / loadThreadContext (round-trip)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("saves and loads a context entry", async () => {
    await saveThreadContext(
      {
        channel: "slack",
        accountId: "W1",
        chatId: "C1",
        threadId: "ts-1234",
        sessionKey: "agent:main:main",
        summary: "Deployed the hotfix to production.",
        task: "Deploy hotfix for billing bug",
      },
      stateDir,
    );

    const entry = await loadThreadContext(
      { channel: "slack", accountId: "W1", chatId: "C1", threadId: "ts-1234" },
      stateDir,
    );
    expect(entry).toBeDefined();
    expect(entry?.summary).toBe("Deployed the hotfix to production.");
    expect(entry?.task).toBe("Deploy hotfix for billing bug");
    expect(entry?.sessionKey).toBe("agent:main:main");
  });

  it("returns undefined for an unknown thread", async () => {
    const entry = await loadThreadContext(
      { channel: "slack", accountId: "W1", threadId: "unknown" },
      stateDir,
    );
    expect(entry).toBeUndefined();
  });

  it("does not load context when chatId differs (cross-chat isolation)", async () => {
    await saveThreadContext(
      {
        channel: "telegram",
        accountId: "bot1",
        chatId: "chat-A",
        threadId: 42,
        sessionKey: "sk",
        summary: "Chat A result",
        task: "task-A",
      },
      stateDir,
    );
    // Same threadId but different chatId — must not return Chat A's context.
    const entry = await loadThreadContext(
      { channel: "telegram", accountId: "bot1", chatId: "chat-B", threadId: 42 },
      stateDir,
    );
    expect(entry).toBeUndefined();
  });

  it("overwrites an existing entry for the same thread", async () => {
    await saveThreadContext(
      {
        channel: "telegram",
        chatId: "chat-1",
        threadId: 99,
        sessionKey: "session-1",
        summary: "First run",
        task: "task-1",
      },
      stateDir,
    );
    await saveThreadContext(
      {
        channel: "telegram",
        chatId: "chat-1",
        threadId: 99,
        sessionKey: "session-2",
        summary: "Second run",
        task: "task-2",
      },
      stateDir,
    );
    const entry = await loadThreadContext(
      { channel: "telegram", chatId: "chat-1", threadId: 99 },
      stateDir,
    );
    expect(entry?.summary).toBe("Second run");
    expect(entry?.sessionKey).toBe("session-2");
  });

  it("truncates overly long summary and task fields", async () => {
    const longSummary = "s".repeat(2_000);
    const longTask = "t".repeat(1_000);
    await saveThreadContext(
      {
        channel: "discord",
        threadId: "ch-1",
        sessionKey: "sk",
        summary: longSummary,
        task: longTask,
      },
      stateDir,
    );
    const entry = await loadThreadContext({ channel: "discord", threadId: "ch-1" }, stateDir);
    expect(entry?.summary.length).toBeLessThanOrEqual(1_000);
    expect(entry?.task.length).toBeLessThanOrEqual(500);
  });

  it("returns undefined for stale entries beyond the TTL", async () => {
    await saveThreadContext(
      {
        channel: "slack",
        accountId: "W2",
        threadId: "old-thread",
        sessionKey: "sk",
        summary: "Old result",
        task: "old task",
      },
      stateDir,
    );

    // Manually back-date the saved entry.
    const storePath = resolveThreadContextStorePath(stateDir);
    const raw = fs.readFileSync(storePath, "utf8");
    const store = JSON.parse(raw) as Record<string, ThreadContextEntry>;
    const key = buildThreadContextKey({
      channel: "slack",
      accountId: "W2",
      threadId: "old-thread",
    });
    store[key].savedAt = Date.now() - THREAD_CONTEXT_TTL_MS - 1_000;
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    const entry = await loadThreadContext(
      { channel: "slack", accountId: "W2", threadId: "old-thread" },
      stateDir,
    );
    expect(entry).toBeUndefined();
  });
});

describe("formatThreadContextNote", () => {
  it("formats a note with task and summary", () => {
    const entry: ThreadContextEntry = {
      threadKey: "slack:default:default:ts-1",
      sessionKey: "agent:main:main",
      summary: "All tests passed.",
      task: "Run the CI suite",
      savedAt: Date.now(),
    };
    const note = formatThreadContextNote(entry);
    expect(note).toContain("[Prior session context for this thread]");
    expect(note).toContain("All tests passed.");
    expect(note).toContain("Run the CI suite");
  });

  it("omits empty fields gracefully", () => {
    const entry: ThreadContextEntry = {
      threadKey: "slack:default:default:ts-2",
      sessionKey: "sk",
      summary: "",
      task: "",
      savedAt: Date.now(),
    };
    const note = formatThreadContextNote(entry);
    expect(note).toContain("[Prior session context for this thread]");
    // Should not include empty Task/Result lines.
    expect(note).not.toContain("Task:");
    expect(note).not.toContain("Result:");
  });
});

describe("MAX_THREAD_CONTEXT_ENTRIES pruning", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not exceed MAX_THREAD_CONTEXT_ENTRIES", async () => {
    // Save one more than the cap.
    for (let i = 0; i <= MAX_THREAD_CONTEXT_ENTRIES; i++) {
      await saveThreadContext(
        {
          channel: "discord",
          threadId: `thread-${i}`,
          sessionKey: "sk",
          summary: `summary ${i}`,
          task: `task ${i}`,
        },
        stateDir,
      );
    }

    const storePath = resolveThreadContextStorePath(stateDir);
    const raw = fs.readFileSync(storePath, "utf8");
    const store = JSON.parse(raw) as Record<string, ThreadContextEntry>;
    expect(Object.keys(store).length).toBeLessThanOrEqual(MAX_THREAD_CONTEXT_ENTRIES);
  });
});
