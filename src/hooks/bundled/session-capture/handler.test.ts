import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExperientialStore } from "../../../experiential/store.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import handler from "./handler.js";

function createMockSessionContent(
  entries: Array<{ role: string; content: string } | { type: string }>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: { role: entry.role, content: entry.content },
        });
      }
      return JSON.stringify(entry);
    })
    .join("\n");
}

describe("session-capture hook", () => {
  it("skips non-command events", async () => {
    const event = createHookEvent("session", "compaction_summary", "agent:main:main", {});
    await handler(event);
    // No crash
  });

  it("skips commands other than new", async () => {
    const event = createHookEvent("command", "help", "agent:main:main", {});
    await handler(event);
  });

  it("skips when no previous session file", async () => {
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
  });

  it("saves session summary on /new command with session data", async () => {
    const tempDir = await makeTempWorkspace("session-capture-test-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Help me design an API" },
      { role: "assistant", content: "Sure, let me help with the API design." },
      { role: "user", content: "What about authentication?" },
      { role: "assistant", content: "We can use JWT tokens for auth." },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });

    await handler(event);

    // Verify summary was saved
    const store = new ExperientialStore();
    try {
      const summaries = store.getRecentSummaries(1);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].sessionKey).toBe("agent:main:main");
      expect(summaries[0].topics.length).toBeGreaterThan(0);
      expect(summaries[0].reconstitutionHints.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("skips when explicitly disabled", async () => {
    const tempDir = await makeTempWorkspace("session-capture-test-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: {
        hooks: {
          internal: {
            entries: {
              "session-capture": { enabled: false },
            },
          },
        },
      },
      previousSessionEntry: {
        sessionId: "test-456",
        sessionFile,
      },
    });

    // Count summaries before
    const storeBefore = new ExperientialStore();
    const countBefore = storeBefore.getRecentSummaries(100).length;
    storeBefore.close();

    await handler(event);

    // Count should not have changed
    const storeAfter = new ExperientialStore();
    const countAfter = storeAfter.getRecentSummaries(100).length;
    storeAfter.close();

    expect(countAfter).toBe(countBefore);
  });

  it("handles empty session files", async () => {
    const tempDir = await makeTempWorkspace("session-capture-test-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "empty.jsonl",
      content: "",
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      previousSessionEntry: {
        sessionId: "test-789",
        sessionFile,
      },
    });

    // Should not throw
    await handler(event);
  });

  it("archives buffered moments after saving summary", async () => {
    const tempDir = await makeTempWorkspace("session-capture-test-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "Design a system" },
      { role: "assistant", content: "Sure, here is the design." },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const sessionKey = "agent:archive-test:main";

    // Seed buffered moments for this session key
    const store = new ExperientialStore();
    try {
      store.saveMoment({
        id: "pre-buf-1",
        version: 1,
        timestamp: Date.now(),
        sessionKey,
        source: "message",
        content: "test moment",
        significance: {
          total: 0.6,
          emotional: 0.3,
          uncertainty: 0.2,
          relationship: 0.1,
          consequential: 0.4,
          reconstitution: 0.3,
        },
        disposition: "buffered",
        reasons: ["test"],
        anchors: ["anchor-a"],
        uncertainties: ["uncertainty-a"],
      });
    } finally {
      store.close();
    }

    const event = createHookEvent("command", "new", sessionKey, {
      previousSessionEntry: { sessionId: "test-archive", sessionFile },
    });

    await handler(event);

    // Verify moments were archived
    const storeAfter = new ExperientialStore();
    try {
      expect(storeAfter.getBufferedMoments(sessionKey)).toHaveLength(0);
      // Moments still exist as archived
      const all = storeAfter.getMomentsBySession(sessionKey);
      expect(all).toHaveLength(1);
      expect(all[0].disposition).toBe("archived");
    } finally {
      storeAfter.close();
    }
  });

  it("filters out command messages starting with /", async () => {
    const tempDir = await makeTempWorkspace("session-capture-test-");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionContent = createMockSessionContent([
      { role: "user", content: "/help" },
      { role: "user", content: "Real message about coding" },
      { role: "assistant", content: "Let me help with coding" },
      { role: "user", content: "/new" },
    ]);
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: sessionContent,
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      previousSessionEntry: {
        sessionId: "test-filter",
        sessionFile,
      },
    });

    await handler(event);

    const store = new ExperientialStore();
    try {
      const summaries = store.getRecentSummaries(1);
      expect(summaries.length).toBeGreaterThan(0);
      // Topics should be from non-command messages
      const allTopics = summaries[0].topics.join(" ");
      expect(allTopics).not.toContain("/help");
      expect(allTopics).not.toContain("/new");
    } finally {
      store.close();
    }
  });
});
