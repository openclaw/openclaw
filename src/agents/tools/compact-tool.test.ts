/**
 * Fork regression tests for the agent compact tool.
 *
 * These tests verify our fork-specific fixes:
 * 1. Live SessionManager — compaction modifies the running instance, not a disposable copy.
 *    After compaction, subsequent appendMessage chains from the compaction entry (correct parentId).
 * 2. buildSessionContext — returns compaction summary + kept messages only; old messages hidden.
 * 3. incrementCompactionCount — session store counter bumps after tool-initiated compaction.
 * 4. Parent chain integrity — new messages after compaction link to the compaction entry's leafId.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config/sessions module so the tool doesn't resolve real paths
const mockStore: Record<string, Record<string, any>> = {};
let mockStorePath = "";

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    resolveStorePath: () => mockStorePath,
    loadSessionStore: () => mockStore.current,
    resolveSessionFilePathOptions: () => ({}),
    resolveSessionFilePath: () => "/dev/null",
  };
});

// Import after mocks
const { createCompactTool } = await import("./compact-tool.js");

// Minimal config that enables the compact tool
function makeConfig(overrides?: Record<string, unknown>) {
  return {
    agents: {
      defaults: {
        compaction: { mode: "agent", reserveTokens: 0, keepRecentTokens: 512 },
        userTimezone: "UTC",
        ...overrides,
      },
    },
  } as any;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "compact-tool-test-"));
}

/** Populate a SessionManager with enough messages to be compactable. */
function populateSession(sm: SessionManager, count = 10): void {
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      sm.appendMessage({ role: "user", content: `User message ${i / 2 + 1}: ${"x".repeat(2000)}`, timestamp: Date.now() });
    } else {
      sm.appendMessage({
        role: "assistant",
        content: `Assistant reply ${Math.ceil(i / 2)}: ${"y".repeat(2000)}`,
        model: "test-model",
        stopReason: "stop",
      } as any);
    }
  }
}

// Valid session key format
const SESSION_KEY = "agent:main:test:compact";

describe("compact-tool", () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    workspaceDir = makeTmpDir();
    fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
    mockStorePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function setupStore(initial: Record<string, any> = { compactionCount: 0 }): void {
    const store = { [SESSION_KEY]: initial };
    mockStore.current = store;
    fs.writeFileSync(mockStorePath, JSON.stringify(store));
  }

  describe("live SessionManager (fork fix: 5f83f939f)", () => {
    it("compaction modifies the live instance — subsequent messages chain from compaction entry", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);
      setupStore();

      const leafBeforeCompact = sm.getLeafId();

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      const result = await tool!.execute("call-1", {
        summary: "Summary: users asked questions, assistant answered them.",
      });
      const text = (result as any).content?.[0]?.text ?? "";
      expect(text).toContain("Compaction complete");

      // leafId must have changed
      const leafAfterCompact = sm.getLeafId();
      expect(leafAfterCompact).not.toBe(leafBeforeCompact);

      // Append a new message on the SAME SessionManager — this is the critical test.
      // Before the fix, this would chain from the OLD leafId (orphaning the compaction).
      sm.appendMessage({ role: "user", content: "Post-compaction message", timestamp: Date.now() });
      const leafAfterMessage = sm.getLeafId();
      expect(leafAfterMessage).not.toBe(leafAfterCompact);

      // The branch must include the compaction entry
      const branch = sm.getBranch();
      const compactionEntry = branch.find((e) => e.type === "compaction");
      expect(compactionEntry).toBeDefined();

      // The post-compaction message must be reachable in the branch
      const lastEntry = branch[branch.length - 1];
      expect(lastEntry.type).toBe("message");
    });
  });

  describe("buildSessionContext after compaction", () => {
    it("returns compaction summary + kept messages, hides old messages", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);
      setupStore();

      const ctxBefore = sm.buildSessionContext();
      expect(ctxBefore.messages.length).toBe(10);

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      await tool!.execute("call-3", {
        summary: "Users discussed weather and travel plans.",
      });

      const ctxAfter = sm.buildSessionContext();
      // Must have fewer messages than before
      expect(ctxAfter.messages.length).toBeLessThan(10);
      // First message should be the compaction summary
      expect(ctxAfter.messages[0].role).toBe("compactionSummary");
    });
  });

  describe("incrementCompactionCount (fork fix: 3805684b5)", () => {
    it("bumps compactionCount in session store after tool compaction", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);
      setupStore({ compactionCount: 0 });

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      await tool!.execute("call-4", {
        summary: "Test compaction count increment.",
      });

      const updatedStore = JSON.parse(fs.readFileSync(mockStorePath, "utf-8"));
      expect(updatedStore[SESSION_KEY].compactionCount).toBe(1);
    });

    it("increments from existing count (not always 1)", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);
      setupStore({ compactionCount: 3 });

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      await tool!.execute("call-5", {
        summary: "Another compaction.",
      });

      const updatedStore = JSON.parse(fs.readFileSync(mockStorePath, "utf-8"));
      expect(updatedStore[SESSION_KEY].compactionCount).toBe(4);
    });
  });

  describe("daily memory journal", () => {
    it("appends compaction summary to memory/YYYY-MM-DD.md", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);
      setupStore();

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      await tool!.execute("call-6", {
        summary: "Journal test: compaction summary content here.",
      });

      const memoryDir = path.join(workspaceDir, "memory");
      const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);

      const content = fs.readFileSync(path.join(memoryDir, files[0]), "utf-8");
      expect(content).toContain("Journal test: compaction summary content here.");
    });
  });

  describe("edge cases", () => {
    it("rejects empty summary", async () => {
      const sm = SessionManager.inMemory();
      populateSession(sm, 10);

      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: makeConfig(),
        workspaceDir,
        getSessionManager: () => sm,
      });

      const result = await tool!.execute("call-7", { summary: "" });
      const text = (result as any).content?.[0]?.text ?? "";
      expect(text).toContain("Error");
    });

    it("returns null when compaction mode is not 'agent'", () => {
      const tool = createCompactTool({
        sessionKey: SESSION_KEY,
        config: { agents: { defaults: { compaction: { mode: "auto" } } } } as any,
        workspaceDir,
      });
      expect(tool).toBeNull();
    });

    it("handles missing session key gracefully", async () => {
      const tool = createCompactTool({
        config: makeConfig(),
        workspaceDir,
      });

      const result = await tool!.execute("call-8", { summary: "No session key" });
      const text = (result as any).content?.[0]?.text ?? "";
      expect(text).toContain("Error");
    });
  });
});
