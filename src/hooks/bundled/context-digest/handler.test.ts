import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import { _clearProcessedSessions } from "../../llm-memory-helpers.js";

vi.mock("../../llm-memory-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm-memory-helpers.js")>();
  return {
    ...actual,
    generateDigestViaLLM: vi.fn().mockResolvedValue(null),
    isTestEnvironment: vi.fn().mockReturnValue(true),
  };
});

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let caseCounter = 0;

async function createCaseWorkspace(prefix = "digest"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${caseCounter}`);
  caseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function createMockSessionJsonl(entries: Array<{ role: string; content: string }>): string {
  return entries
    .map((e) =>
      JSON.stringify({
        type: "message",
        message: { role: e.role, content: e.content },
      }),
    )
    .join("\n");
}

async function writeSessionStore(
  storePath: string,
  store: Record<string, { sessionId: string; updatedAt: number; sessionFile: string }>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-context-digest-"));
});

afterAll(async () => {
  if (suiteWorkspaceRoot) {
    await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  _clearProcessedSessions();
});

describe("context-digest handler", () => {
  it("should ignore non-command/non-session events", async () => {
    const workDir = await createCaseWorkspace();
    const event = createHookEvent("message", "received", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
    });
    await handler(event);
    const memoryDir = path.join(workDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("should create a digest file on command:new with empty store", async () => {
    const workDir = await createCaseWorkspace();
    const storeDir = path.join(workDir, "sessions");
    await fs.mkdir(storeDir, { recursive: true });
    const storePath = path.join(storeDir, "sessions.json");
    await writeSessionStore(storePath, {});

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "sess-empty" },
    });

    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    expect(content).toContain("# Context Digest (auto-generated)");
    expect(content).toContain("Sessions covered: 0");
    expect(content).toContain("No conversations in the recent window.");
  });

  it("should generate a fallback digest from session transcripts", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = path.join(sessionsDir, "abc123.jsonl");
    await fs.writeFile(
      sessionFile,
      createMockSessionJsonl([
        { role: "user", content: "Tell me about API design patterns" },
        { role: "assistant", content: "Here are common API patterns..." },
        { role: "user", content: "What about REST vs GraphQL?" },
      ]),
      "utf-8",
    );

    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main:main": {
        sessionId: "abc123",
        updatedAt: Date.now() - 1000,
        sessionFile,
      },
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "sess-fb" },
    });

    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    expect(content).toContain("# Context Digest (auto-generated)");
    expect(content).toContain("Sessions covered: 1");
    expect(content).toContain("Tell me about API design patterns");
  });

  it("should filter sessions outside the configured window", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const oldFile = path.join(sessionsDir, "old.jsonl");
    await fs.writeFile(
      oldFile,
      createMockSessionJsonl([{ role: "user", content: "Very old conversation" }]),
      "utf-8",
    );

    const recentFile = path.join(sessionsDir, "recent.jsonl");
    await fs.writeFile(
      recentFile,
      createMockSessionJsonl([{ role: "user", content: "Recent conversation" }]),
      "utf-8",
    );

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main:old": {
        sessionId: "old",
        updatedAt: thirtyDaysAgo,
        sessionFile: oldFile,
      },
      "agent:main:recent": {
        sessionId: "recent",
        updatedAt: Date.now() - 1000,
        sessionFile: recentFile,
      },
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "sess-window" },
    });

    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    expect(content).toContain("Sessions covered: 1");
    expect(content).toContain("Recent conversation");
    expect(content).not.toContain("Very old conversation");
  });

  it("should enforce the 8KB output cap", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Create many sessions with long content
    const store: Record<string, { sessionId: string; updatedAt: number; sessionFile: string }> = {};
    for (let i = 0; i < 20; i++) {
      const sessionFile = path.join(sessionsDir, `sess-${i}.jsonl`);
      const longContent = "A".repeat(2000);
      await fs.writeFile(
        sessionFile,
        createMockSessionJsonl([
          { role: "user", content: `Topic ${i}: ${longContent}` },
          { role: "assistant", content: `Response ${i}: ${longContent}` },
        ]),
        "utf-8",
      );
      store[`agent:main:session-${i}`] = {
        sessionId: `sess-${i}`,
        updatedAt: Date.now() - i * 1000,
        sessionFile,
      };
    }

    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, store);

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "sess-cap" },
    });

    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    // Header + body should not exceed 8KB + header size
    expect(content.length).toBeLessThan(10_000);
  });

  it("should skip duplicate session:end events (dedup)", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, {});

    const sessionId = "dedup-session-123";

    // First trigger (command:new)
    const event1 = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId },
    });
    await handler(event1);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const _content1 = await fs.readFile(digestPath, "utf-8");

    // Update the content to detect if re-write happens
    await fs.writeFile(digestPath, "MARKER", "utf-8");

    // Second trigger (session:end) with same sessionId — should be deduped
    const event2 = createHookEvent("session", "end", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId },
    });
    await handler(event2);

    const content2 = await fs.readFile(digestPath, "utf-8");
    expect(content2).toBe("MARKER");
  });

  it("should process session:end events for new session IDs", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, {});

    const event = createHookEvent("session", "end", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "new-session-end-id" },
    });
    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    expect(content).toContain("# Context Digest (auto-generated)");
  });

  it("should handle command:reset events", async () => {
    const workDir = await createCaseWorkspace();
    const sessionsDir = path.join(workDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeSessionStore(storePath, {});

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: workDir } } },
      storePath,
      previousSessionEntry: { sessionId: "sess-reset" },
    });
    await handler(event);

    const digestPath = path.join(workDir, "memory", "context-digest.md");
    const content = await fs.readFile(digestPath, "utf-8");
    expect(content).toContain("# Context Digest (auto-generated)");
  });
});
