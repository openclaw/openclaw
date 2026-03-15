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

  // Helper to drain postHookActions with per-action error isolation,
  // matching triggerInternalHook's actual drain behaviour.
  async function drainPostHookActions(event: {
    postHookActions: Array<() => Promise<void> | void>;
  }) {
    for (const action of event.postHookActions) {
      try {
        await action();
      } catch {
        // Per-action isolation — one failure doesn't block others.
      }
    }
  }

  it("blockSessionSave (pre-set) prevents memory file creation", async () => {
    const tempDir = await createCaseWorkspace("block-save");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "secret" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.blockSessionSave = true;

    await handler(event);
    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
    expect(memoryFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("blockSessionSave (late-set) retracts memory file via postHookActions", async () => {
    const tempDir = await createCaseWorkspace("block-save-late");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "secret" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });

    // Handler writes the file inline (fail-safe)
    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    let memoryFiles = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(memoryFiles.length).toBeGreaterThan(0); // file exists after inline write

    // A later hook sets blockSessionSave
    event.context.blockSessionSave = true;

    // Post-hook action retracts the file
    await drainPostHookActions(event);

    memoryFiles = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(memoryFiles).toHaveLength(0);
  });

  it("sessionSaveContent (pre-set) overrides saved content", async () => {
    const tempDir = await createCaseWorkspace("custom-content");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "original" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveContent = "Custom summary from upstream hook";

    await handler(event);
    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const content = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(content).toBe("Custom summary from upstream hook");
    expect(content).not.toContain("original");
  });

  it("sessionSaveContent (late-set) overwrites file via postHookActions", async () => {
    const tempDir = await createCaseWorkspace("late-custom-content");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "original" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });

    // Handler writes default content inline
    await handler(event);

    // A later hook sets custom content
    event.context.sessionSaveContent = "Redacted by policy";

    // Post-hook action overwrites
    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const content = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(content).toBe("Redacted by policy");
  });

  it("sessionSaveContent empty string writes blank marker file", async () => {
    const tempDir = await createCaseWorkspace("empty-content");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "sensitive data" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveContent = "";

    await handler(event);
    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const content = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(content).toBe("");
  });

  it("fail-safe: file is preserved if postHookActions never drain", async () => {
    const tempDir = await createCaseWorkspace("fail-safe");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "important data" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });

    await handler(event);
    // Deliberately do NOT drain postHookActions — simulates a system failure

    const memoryDir = path.join(tempDir, "memory");
    const files = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const content = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(content).toContain("important data");
  });

  it("blockSessionSave pre-set then cleared with sessionSaveContent creates file (mkdir edge case)", async () => {
    // Regression: when blockSessionSave is true initially, the inline write
    // is skipped — including the fs.mkdir.  If a later hook clears the flag
    // and sets sessionSaveContent, the post-hook write must create the
    // directory itself or it fails with ENOENT.
    const tempDir = await createCaseWorkspace("block-then-clear");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "secret" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.blockSessionSave = true;

    // Handler runs — inline write is skipped, memoryDir never created
    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const existsBefore = await fs
      .stat(memoryDir)
      .then(() => true)
      .catch(() => false);
    expect(existsBefore).toBe(false);

    // A later hook clears blockSessionSave and sets custom content
    event.context.blockSessionSave = false;
    event.context.sessionSaveContent = "Replacement content from policy hook";

    // Post-hook should create the directory and write the file
    await drainPostHookActions(event);

    const files = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const content = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(content).toBe("Replacement content from policy hook");
  });

  it("blockSessionSave takes precedence over sessionSaveContent (both pre-set)", async () => {
    const tempDir = await createCaseWorkspace("block-beats-content-pre");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "secret" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.blockSessionSave = true;
    event.context.sessionSaveContent = "Should not appear";

    await handler(event);
    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
    expect(memoryFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("blockSessionSave takes precedence over sessionSaveContent (both late-set)", async () => {
    const tempDir = await createCaseWorkspace("block-beats-content-late");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "secret" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });

    // Handler writes inline (no flags set yet)
    await handler(event);

    // Later hooks set both flags
    event.context.blockSessionSave = true;
    event.context.sessionSaveContent = "Should not appear";

    await drainPostHookActions(event);

    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = (await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md"));
    expect(memoryFiles).toHaveLength(0);
  });

  it("sessionSaveRedirectPath writes to alternate location", async () => {
    const tempDir = await createCaseWorkspace("redirect");
    const quarantine = path.join(tempDir, "quarantine");
    await fs.mkdir(quarantine, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "redirected content" }]),
    });

    const redirectFile = path.join(quarantine, "quarantined-session.md");
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = redirectFile;

    await handler(event);

    const content = await fs.readFile(redirectFile, "utf-8");
    expect(content).toContain("redirected content");

    // Verify default memory/ dir was not written
    const memoryFiles = await fs.readdir(path.join(tempDir, "memory")).catch(() => [] as string[]);
    expect(memoryFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("sessionSaveRedirectPath resolves relative paths against workspace", async () => {
    const tempDir = await createCaseWorkspace("redirect-rel");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "relative redirect" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = "quarantine/redirected.md";

    await handler(event);

    const content = await fs.readFile(path.join(tempDir, "quarantine", "redirected.md"), "utf-8");
    expect(content).toContain("relative redirect");
  });

  it("sessionSaveRedirectPath rejects paths outside workspace", async () => {
    const tempDir = await createCaseWorkspace("redirect-escape");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "escape attempt" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    const outsideDir = path.join(path.dirname(tempDir), `outside-workspace-target-${Date.now()}`);
    const escapePath = path.join(outsideDir, "stolen-session.md");
    event.context.sessionSaveRedirectPath = escapePath;

    await handler(event);

    const exists = await fs.stat(escapePath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
    await fs.rm(outsideDir, { recursive: true }).catch(() => {});
    const memoryDir2 = path.join(tempDir, "memory");
    const memoryFiles2 = await fs.readdir(memoryDir2).catch(() => [] as string[]);
    expect(memoryFiles2.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("sessionSaveRedirectPath rejects relative traversal paths", async () => {
    const tempDir = await createCaseWorkspace("redirect-rel-escape");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "traversal attempt" }]),
    });

    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = "../../../etc/stolen.md";

    await handler(event);

    // Should fail closed — no file written anywhere
    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
    expect(memoryFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("sessionSaveContent + sessionSaveRedirectPath writes custom content to redirect path", async () => {
    const tempDir = await createCaseWorkspace("custom-content-redirect");
    const quarantine = path.join(tempDir, "quarantine");
    await fs.mkdir(quarantine, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "original" }]),
    });

    const redirectFile = path.join(quarantine, "custom.md");
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveContent = "Redacted by policy";
    event.context.sessionSaveRedirectPath = redirectFile;

    await handler(event);

    const content = await fs.readFile(redirectFile, "utf-8");
    expect(content).toBe("Redacted by policy");
    const memoryFiles3 = await fs.readdir(path.join(tempDir, "memory")).catch(() => [] as string[]);
    expect(memoryFiles3.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("late-set blockSessionSave retracts a redirected write", async () => {
    const tempDir = await createCaseWorkspace("late-block-redirect");
    const quarantine = path.join(tempDir, "quarantine");
    await fs.mkdir(quarantine, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "redirected" }]),
    });

    const redirectFile = path.join(quarantine, "quarantined.md");
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = redirectFile;

    await handler(event);

    // Verify redirected file was written
    const content = await fs.readFile(redirectFile, "utf-8");
    expect(content).toContain("redirected");

    // A later hook blocks all saves — blockSessionSave is a security
    // primitive meaning "no persistence, period" and wins over redirects.
    event.context.blockSessionSave = true;
    await drainPostHookActions(event);

    // The redirected file should be retracted
    const exists = await fs.stat(redirectFile).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it("late-set sessionSaveContent does NOT override redirected write content", async () => {
    const tempDir = await createCaseWorkspace("late-content-redirect");
    const quarantine = path.join(tempDir, "quarantine");
    await fs.mkdir(quarantine, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "original redirect content" }]),
    });

    const redirectFile = path.join(quarantine, "preserved.md");
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = redirectFile;

    await handler(event);

    // A later hook tries to override content — should be ignored for redirects
    event.context.sessionSaveContent = "This should NOT replace redirect content";
    await drainPostHookActions(event);

    // Original redirect content should be preserved
    const content = await fs.readFile(redirectFile, "utf-8");
    expect(content).toContain("original redirect content");
    expect(content).not.toContain("This should NOT replace");
  });
});
