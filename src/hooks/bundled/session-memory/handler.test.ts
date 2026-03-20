import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

/**
 * Create a mock session JSONL file with various entry types
 */
function createMockSessionContent(
  entries: Array<{ role: string; content: string } | ({ type: string } & Record<string, unknown>)>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: {
            role: entry.role,
            content: entry.content,
          },
        });
      }
      // Non-message entry (tool call, system, etc.)
      return JSON.stringify(entry);
    })
    .join("\n");
}

async function runNewWithPreviousSessionEntry(params: {
  tempDir: string;
  previousSessionEntry: { sessionId: string; sessionFile?: string };
  cfg?: OpenClawConfig;
  action?: "new" | "reset";
  sessionKey?: string;
  workspaceDirOverride?: string;
}): Promise<{ files: string[]; memoryContent: string }> {
  const event = createHookEvent(
    "command",
    params.action ?? "new",
    params.sessionKey ?? "agent:main:main",
    {
      cfg:
        params.cfg ??
        ({
          agents: { defaults: { workspace: params.tempDir } },
        } satisfies OpenClawConfig),
      previousSessionEntry: params.previousSessionEntry,
      ...(params.workspaceDirOverride ? { workspaceDir: params.workspaceDirOverride } : {}),
    },
  );

  await handler(event);

  const memoryDir = path.join(params.tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const memoryContent =
    files.length > 0 ? await fs.readFile(path.join(memoryDir, files[0]), "utf-8") : "";
  return { files, memoryContent };
}

async function runNewWithPreviousSession(params: {
  sessionContent: string;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
}): Promise<{ tempDir: string; files: string[]; memoryContent: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "test-session.jsonl",
    content: params.sessionContent,
  });

  const cfg =
    params.cfg?.(tempDir) ??
    ({
      agents: { defaults: { workspace: tempDir } },
    } satisfies OpenClawConfig);

  const { files, memoryContent } = await runNewWithPreviousSessionEntry({
    tempDir,
    cfg,
    action: params.action,
    previousSessionEntry: {
      sessionId: "test-123",
      sessionFile,
    },
  });
  return { tempDir, files, memoryContent };
}

function makeSessionMemoryConfig(tempDir: string, messages?: number): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
    ...(typeof messages === "number"
      ? {
          hooks: {
            internal: {
              entries: {
                "session-memory": { enabled: true, messages },
              },
            },
          },
        }
      : {}),
  } satisfies OpenClawConfig;
}

async function createSessionMemoryWorkspace(params?: {
  activeSession?: { name: string; content: string };
}): Promise<{ tempDir: string; sessionsDir: string; activeSessionFile?: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  if (!params?.activeSession) {
    return { tempDir, sessionsDir };
  }

  const activeSessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: params.activeSession.name,
    content: params.activeSession.content,
  });
  return { tempDir, sessionsDir, activeSessionFile };
}

async function loadMemoryFromActiveSessionPointer(params: {
  tempDir: string;
  activeSessionFile: string;
}): Promise<string> {
  const { memoryContent } = await runNewWithPreviousSessionEntry({
    tempDir: params.tempDir,
    previousSessionEntry: {
      sessionId: "test-123",
      sessionFile: params.activeSessionFile,
    },
  });
  return memoryContent;
}

function expectMemoryConversation(params: {
  memoryContent: string;
  user: string;
  assistant: string;
  absent?: string;
}) {
  expect(params.memoryContent).toContain(`user: ${params.user}`);
  expect(params.memoryContent).toContain(`assistant: ${params.assistant}`);
  if (params.absent) {
    expect(params.memoryContent).not.toContain(params.absent);
  }
}

describe("session-memory hook", () => {
  it("skips non-command events", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for non-command events
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("skips commands other than new", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for other commands
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("creates memory file with session content on /new command", async () => {
    // Create a mock session file with user/assistant messages
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "2+2 equals 4" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({ sessionContent });
    expect(files.length).toBe(1);

    // Read the memory file and verify content
    expect(memoryContent).toContain("user: Hello there");
    expect(memoryContent).toContain("assistant: Hi! How can I help?");
    expect(memoryContent).toContain("user: What is 2+2?");
    expect(memoryContent).toContain("assistant: 2+2 equals 4");
  });

  it("creates memory file with session content on /reset command", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Please reset and keep notes" },
      { role: "assistant", content: "Captured before reset" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      action: "reset",
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain("user: Please reset and keep notes");
    expect(memoryContent).toContain("assistant: Captured before reset");
  });

  it("prefers workspaceDir from hook context when sessionKey points at main", async () => {
    const mainWorkspace = await createCaseWorkspace("workspace-main");
    const naviWorkspace = await createCaseWorkspace("workspace-navi");
    const naviSessionsDir = path.join(naviWorkspace, "sessions");
    await fs.mkdir(naviSessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: naviSessionsDir,
      name: "navi-session.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "Remember this under Navi" },
        { role: "assistant", content: "Stored in the bound workspace" },
      ]),
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir: naviWorkspace,
      cfg: {
        agents: {
          defaults: { workspace: mainWorkspace },
          list: [{ id: "navi", workspace: naviWorkspace }],
        },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      workspaceDirOverride: naviWorkspace,
      previousSessionEntry: {
        sessionId: "navi-session",
        sessionFile,
      },
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain("user: Remember this under Navi");
    expect(memoryContent).toContain("assistant: Stored in the bound workspace");
    expect(memoryContent).toContain("- **Session Key**: agent:navi:main");
    await expect(fs.access(path.join(mainWorkspace, "memory"))).rejects.toThrow();
  });

  it("filters out non-message entries (tool calls, system)", async () => {
    // Create session with mixed entry types
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello" },
      { type: "tool_use", tool: "search", input: "test" },
      { role: "assistant", content: "World" },
      { type: "tool_result", result: "found it" },
      { role: "user", content: "Thanks" },
    ]);
    const { memoryContent } = await runNewWithPreviousSession({ sessionContent });

    // Only user/assistant messages should be present
    expect(memoryContent).toContain("user: Hello");
    expect(memoryContent).toContain("assistant: World");
    expect(memoryContent).toContain("user: Thanks");
    // Tool entries should not appear
    expect(memoryContent).not.toContain("tool_use");
    expect(memoryContent).not.toContain("tool_result");
    expect(memoryContent).not.toContain("search");
  });

  it("filters out inter-session user messages", async () => {
    const sessionContent = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "Forwarded internal instruction",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Acknowledged" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "External follow-up" },
      }),
    ].join("\n");
    const { memoryContent } = await runNewWithPreviousSession({ sessionContent });

    expect(memoryContent).not.toContain("Forwarded internal instruction");
    expect(memoryContent).toContain("assistant: Acknowledged");
    expect(memoryContent).toContain("user: External follow-up");
  });

  it("filters out command messages starting with /", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "/help" },
      { role: "assistant", content: "Here is help info" },
      { role: "user", content: "Normal message" },
      { role: "user", content: "/new" },
    ]);
    const { memoryContent } = await runNewWithPreviousSession({ sessionContent });

    // Command messages should be filtered out
    expect(memoryContent).not.toContain("/help");
    expect(memoryContent).not.toContain("/new");
    // Normal messages should be present
    expect(memoryContent).toContain("assistant: Here is help info");
    expect(memoryContent).toContain("user: Normal message");
  });

  it("respects custom messages config (limits to N messages)", async () => {
    // Create 10 messages
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({ role: "user", content: `Message ${i}` });
    }
    const sessionContent = createMockSessionContent(entries);
    const { memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      cfg: (tempDir) => makeSessionMemoryConfig(tempDir, 3),
    });

    // Only last 3 messages should be present
    expect(memoryContent).not.toContain("user: Message 1\n");
    expect(memoryContent).not.toContain("user: Message 7\n");
    expect(memoryContent).toContain("user: Message 8");
    expect(memoryContent).toContain("user: Message 9");
    expect(memoryContent).toContain("user: Message 10");
  });

  it("filters messages before slicing (fix for #2681)", async () => {
    // Create session with many tool entries interspersed with messages
    // This tests that we filter FIRST, then slice - not the other way around
    const entries = [
      { role: "user", content: "First message" },
      { type: "tool_use", tool: "test1" },
      { type: "tool_result", result: "result1" },
      { role: "assistant", content: "Second message" },
      { type: "tool_use", tool: "test2" },
      { type: "tool_result", result: "result2" },
      { role: "user", content: "Third message" },
      { type: "tool_use", tool: "test3" },
      { type: "tool_result", result: "result3" },
      { role: "assistant", content: "Fourth message" },
    ];
    const sessionContent = createMockSessionContent(entries);
    const { memoryContent } = await runNewWithPreviousSession({
      sessionContent,
      cfg: (tempDir) => makeSessionMemoryConfig(tempDir, 3),
    });

    // Should have exactly 3 user/assistant messages (the last 3)
    expect(memoryContent).not.toContain("First message");
    expect(memoryContent).toContain("user: Third message");
    expect(memoryContent).toContain("assistant: Second message");
    expect(memoryContent).toContain("assistant: Fourth message");
  });

  it("falls back to latest .jsonl.reset.* transcript when active file is empty", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { name: "test-session.jsonl", content: "" },
    });

    // Simulate /new rotation where useful content is now in .reset.* file
    const resetContent = createMockSessionContent([
      { role: "user", content: "Message from rotated transcript" },
      { role: "assistant", content: "Recovered from reset fallback" },
    ]);
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
      content: resetContent,
    });

    const { memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile: activeSessionFile!,
      },
    });

    expect(memoryContent).toContain("user: Message from rotated transcript");
    expect(memoryContent).toContain("assistant: Recovered from reset fallback");
  });

  it("handles reset-path session pointers from previousSessionEntry", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "reset-pointer-session";
    const resetSessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
      content: createMockSessionContent([
        { role: "user", content: "Message from reset pointer" },
        { role: "assistant", content: "Recovered directly from reset file" },
      ]),
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: makeSessionMemoryConfig(tempDir),
      previousSessionEntry: {
        sessionId,
        sessionFile: resetSessionFile,
      },
    });
    expect(files.length).toBe(1);

    expect(memoryContent).toContain("user: Message from reset pointer");
    expect(memoryContent).toContain("assistant: Recovered directly from reset file");
  });

  it("recovers transcript when previousSessionEntry.sessionFile is missing", async () => {
    const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "missing-session-file";
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl`,
      content: "",
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
      content: createMockSessionContent([
        { role: "user", content: "Recovered with missing sessionFile pointer" },
        { role: "assistant", content: "Recovered by sessionId fallback" },
      ]),
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: makeSessionMemoryConfig(tempDir),
      previousSessionEntry: {
        sessionId,
      },
    });
    expect(files.length).toBe(1);

    expect(memoryContent).toContain("user: Recovered with missing sessionFile pointer");
    expect(memoryContent).toContain("assistant: Recovered by sessionId fallback");
  });

  it("prefers the newest reset transcript when multiple reset candidates exist", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { name: "test-session.jsonl", content: "" },
    });

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Older rotated transcript" },
        { role: "assistant", content: "Old summary" },
      ]),
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Newest rotated transcript" },
        { role: "assistant", content: "Newest summary" },
      ]),
    });

    const memoryContent = await loadMemoryFromActiveSessionPointer({
      tempDir,
      activeSessionFile: activeSessionFile!,
    });

    expectMemoryConversation({
      memoryContent,
      user: "Newest rotated transcript",
      assistant: "Newest summary",
      absent: "Older rotated transcript",
    });
  });

  it("prefers active transcript when it is non-empty even with reset candidates", async () => {
    const { tempDir, sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: {
        name: "test-session.jsonl",
        content: createMockSessionContent([
          { role: "user", content: "Active transcript message" },
          { role: "assistant", content: "Active transcript summary" },
        ]),
      },
    });

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Reset fallback message" },
        { role: "assistant", content: "Reset fallback summary" },
      ]),
    });

    const memoryContent = await loadMemoryFromActiveSessionPointer({
      tempDir,
      activeSessionFile: activeSessionFile!,
    });

    expectMemoryConversation({
      memoryContent,
      user: "Active transcript message",
      assistant: "Active transcript summary",
      absent: "Reset fallback message",
    });
  });

  it("handles empty session files gracefully", async () => {
    // Should not throw
    const { files } = await runNewWithPreviousSession({ sessionContent: "" });
    expect(files.length).toBe(1);
  });

  it("handles session files with fewer messages than requested", async () => {
    // Only 2 messages but requesting 15 (default)
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Only message 1" },
      { role: "assistant", content: "Only message 2" },
    ]);
    const { memoryContent } = await runNewWithPreviousSession({ sessionContent });

    // Both messages should be included
    expect(memoryContent).toContain("user: Only message 1");
    expect(memoryContent).toContain("assistant: Only message 2");
  });

  describe("session creation date for memory filename", () => {
    it("uses session creation timestamp for date when session header has valid timestamp", async () => {
      // Session created on 2026-03-10, but /new runs on 2026-03-12
      const sessionCreatedAt = "2026-03-10T08:30:00.000Z";
      const sessionContent = [
        JSON.stringify({ type: "session", timestamp: sessionCreatedAt }),
        JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "World" } }),
      ].join("\n");

      const tempDir = await createCaseWorkspace("workspace");
      const sessionsDir = path.join(tempDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = await writeWorkspaceFile({
        dir: sessionsDir,
        name: "test-session.jsonl",
        content: sessionContent,
      });

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        previousSessionEntry: { sessionId: "test-123", sessionFile },
      });

      // File should be named with session creation date
      expect(files[0]).toMatch(/^2026-03-10-/);
      // Header should show session creation time
      expect(memoryContent).toContain("# Session: 2026-03-10 08:30:00 UTC");
    });

    it("falls back to event timestamp when session header has no timestamp field", async () => {
      const sessionContent = [
        JSON.stringify({ type: "session" }), // no timestamp field
        JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "World" } }),
      ].join("\n");

      const { files } = await runNewWithPreviousSession({ sessionContent });

      // File should be named with today's date (event timestamp)
      const today = new Date().toISOString().split("T")[0];
      expect(files[0]).toMatch(new RegExp(`^${today}-`));
    });

    it("falls back to event timestamp when session file has no session header", async () => {
      // No type="session" entry at all
      const sessionContent = createMockSessionContent([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "World" },
      ]);

      const { files } = await runNewWithPreviousSession({ sessionContent });

      const today = new Date().toISOString().split("T")[0];
      expect(files[0]).toMatch(new RegExp(`^${today}-`));
    });

    it("falls back to event timestamp when session header has invalid date string", async () => {
      const sessionContent = [
        JSON.stringify({ type: "session", timestamp: "not-a-valid-date" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "World" } }),
      ].join("\n");

      const tempDir = await createCaseWorkspace("workspace");
      const sessionsDir = path.join(tempDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = await writeWorkspaceFile({
        dir: sessionsDir,
        name: "test-session.jsonl",
        content: sessionContent,
      });

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        previousSessionEntry: { sessionId: "test-123", sessionFile },
      });

      // Should still create a memory file (no silent failure)
      expect(files.length).toBe(1);
      // Should use today's date (fallback)
      const today = new Date().toISOString().split("T")[0];
      expect(files[0]).toMatch(new RegExp(`^${today}-`));
      // Memory content should still have the messages
      expect(memoryContent).toContain("user: Hello");
      expect(memoryContent).toContain("assistant: World");
    });

    it("uses event timestamp for HHMM slug even when session has creation timestamp", async () => {
      // This tests that the HHMM slug (for uniqueness) uses event.timestamp
      // while date uses session creation timestamp
      const sessionCreatedAt = "2026-03-10T08:30:00.000Z";
      const sessionContent = [
        JSON.stringify({ type: "session", timestamp: sessionCreatedAt }),
        JSON.stringify({ type: "message", message: { role: "user", content: "Test" } }),
      ].join("\n");

      const tempDir = await createCaseWorkspace("workspace");
      const sessionsDir = path.join(tempDir, "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = await writeWorkspaceFile({
        dir: sessionsDir,
        name: "test-session.jsonl",
        content: sessionContent,
      });

      // Disable LLM slug to force HHMM fallback
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: tempDir } },
        hooks: { internal: { entries: { "session-memory": { enabled: true, llmSlug: false } } } },
      } as OpenClawConfig;

      // Capture time before calling the handler to avoid minute-boundary flakiness
      const preRunTime = new Date();
      const { files } = await runNewWithPreviousSessionEntry({
        tempDir,
        cfg,
        previousSessionEntry: { sessionId: "test-123", sessionFile },
      });

      // File should be named with session creation date, but HHMM from event
      expect(files[0]).toMatch(/^2026-03-10-\d{4}\.md$/);
      // The HHMM should NOT be 0830 (session creation time) but rather current time
      const hhmm = files[0].match(/2026-03-10-(\d{4})\.md$/)?.[1];
      // HHMM should be from current time, not from sessionCreatedAt
      // Use pre/post time window to avoid minute-boundary flakiness
      const postRunTime = new Date();
      const preHHMM = preRunTime.toISOString().split("T")[1].split(":").slice(0, 2).join("");
      const postHHMM = postRunTime.toISOString().split("T")[1].split(":").slice(0, 2).join("");
      expect([preHHMM, postHHMM]).toContain(hhmm);
    });

    it("uses session creation date from .reset.* fallback when base file is empty", async () => {
      // Simulate a rotated session where the base file is empty and content is in .reset.* file
      const sessionCreatedAt = "2026-02-16T10:30:00.000Z";
      const { tempDir, sessionsDir } = await createSessionMemoryWorkspace({
        activeSession: { name: "test-session.jsonl", content: "" },
      });

      // Create .reset.* file with session header containing creation time
      const resetContent = [
        JSON.stringify({ type: "session", timestamp: sessionCreatedAt }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Message from rotated session" },
        }),
      ].join("\n");
      await writeWorkspaceFile({
        dir: sessionsDir,
        name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
        content: resetContent,
      });

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        cfg: {
          ...makeSessionMemoryConfig(tempDir),
          hooks: { internal: { entries: { "session-memory": { enabled: true, llmSlug: false } } } },
        } as OpenClawConfig,
        previousSessionEntry: {
          sessionId: "test-123",
          sessionFile: path.join(sessionsDir, "test-session.jsonl"),
        },
      });

      // File should be named with session creation date from .reset.* file
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^2026-02-16-\d{4}\.md$/);
      expect(memoryContent).toContain("2026-02-16 10:30:00"); // timeStr in header
      expect(memoryContent).toContain("Message from rotated session");
    });

    it("uses event timestamp when no session file is available", async () => {
      const tempDir = await createCaseWorkspace("workspace");

      const { files } = await runNewWithPreviousSessionEntry({
        tempDir,
        previousSessionEntry: { sessionId: "test-123" }, // no sessionFile
      });

      // Should still create a memory file
      expect(files.length).toBe(1);
      const today = new Date().toISOString().split("T")[0];
      expect(files[0]).toMatch(new RegExp(`^${today}-`));
    });
  });
});
