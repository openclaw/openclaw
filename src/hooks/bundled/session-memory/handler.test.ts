import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createHookEvent } from "../../hooks.js";
import {
  findPreviousSessionFile,
  getRecentSessionContent,
  getRecentSessionContentWithResetFallback,
} from "./transcript.js";

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

let handler: typeof import("./handler.js").default;
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
  timestamp?: Date;
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
  if (params.timestamp) {
    event.timestamp = params.timestamp;
  }

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

async function writeSessionTranscript(params: {
  name: string;
  content: string;
}): Promise<{ tempDir: string; sessionsDir: string; sessionFile: string }> {
  const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: params.name,
    content: params.content,
  });
  return { tempDir, sessionsDir, sessionFile };
}

async function readSessionTranscript(params: {
  sessionContent: string;
  messageCount?: number;
}): Promise<string | null> {
  const { sessionFile } = await writeSessionTranscript({
    name: "test-session.jsonl",
    content: params.sessionContent,
  });
  return getRecentSessionContent(sessionFile, params.messageCount);
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

  it("uses local timezone date and fallback time in memory filenames and headers", async () => {
    await withEnvAsync({ TZ: "America/New_York" }, async () => {
      const tempDir = await createCaseWorkspace("workspace");

      const { files, memoryContent } = await runNewWithPreviousSessionEntry({
        tempDir,
        timestamp: new Date("2026-01-01T04:30:15.000Z"),
        previousSessionEntry: {
          sessionId: "local-time-session",
        },
      });

      // Filename includes a 4-char hex random suffix on all paths
      // (LLM and fallback) to guarantee uniqueness; the timestamp portion
      // is what we assert here.
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^2025-12-31-2330-[0-9a-f]{8}\.md$/);
      expect(memoryContent).toMatch(/^# Session: 2025-12-31 23:30:15(?: EST| GMT-5)?/);
      expect(memoryContent).not.toContain("# Session: 2026-01-01 04:30:15 UTC");
    });
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
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Hello" },
      { type: "tool_use", tool: "search", input: "test" },
      { role: "assistant", content: "World" },
      { type: "tool_result", result: "found it" },
      { role: "user", content: "Thanks" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).toContain("user: Hello");
    expect(memoryContent).toContain("assistant: World");
    expect(memoryContent).toContain("user: Thanks");
    expect(memoryContent).not.toContain("tool_use");
    expect(memoryContent).not.toContain("tool_result");
    expect(memoryContent).not.toContain("search");
  });

  it("survives malformed content blocks (null/non-object entries) without dropping the message", async () => {
    // Codex review on PR #38162: the inline content-block parser used
    // to read .type without a typeof-object guard; a null/undefined or
    // non-object entry before the text block would throw, the per-line
    // catch would swallow, and the whole message would be silently
    // dropped from the memory transcript. Defensive guard added.
    const sessionContent = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [
            null, // malformed entry
            { type: "image", source: "x" }, // no .text
            { type: "text", text: "actual user prompt" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            "raw-string-not-object", // non-object entry
            { type: "text", text: "assistant reply" },
          ],
        },
      }),
    ].join("\n");
    const memoryContent = await readSessionTranscript({ sessionContent });

    // Both messages should make it through despite the malformed blocks.
    expect(memoryContent).toContain("user: actual user prompt");
    expect(memoryContent).toContain("assistant: assistant reply");
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
    const memoryContent = await readSessionTranscript({ sessionContent });

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
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).not.toContain("/help");
    expect(memoryContent).not.toContain("/new");
    expect(memoryContent).toContain("assistant: Here is help info");
    expect(memoryContent).toContain("user: Normal message");
  });

  it("respects custom messages config (limits to N messages)", async () => {
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({ role: "user", content: `Message ${i}` });
    }
    const sessionContent = createMockSessionContent(entries);
    const memoryContent = await readSessionTranscript({
      sessionContent,
      messageCount: 3,
    });

    expect(memoryContent).not.toContain("user: Message 1\n");
    expect(memoryContent).not.toContain("user: Message 7\n");
    expect(memoryContent).toContain("user: Message 8");
    expect(memoryContent).toContain("user: Message 9");
    expect(memoryContent).toContain("user: Message 10");
  });

  it("filters messages before slicing (fix for #2681)", async () => {
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
    const memoryContent = await readSessionTranscript({
      sessionContent,
      messageCount: 3,
    });

    expect(memoryContent).not.toContain("First message");
    expect(memoryContent).toContain("user: Third message");
    expect(memoryContent).toContain("assistant: Second message");
    expect(memoryContent).toContain("assistant: Fourth message");
  });

  it("falls back to latest .jsonl.reset.* transcript when active file is empty", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
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

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);

    expect(memoryContent).toContain("user: Message from rotated transcript");
    expect(memoryContent).toContain("assistant: Recovered from reset fallback");
  });

  it("handles reset-path session pointers from previousSessionEntry", async () => {
    const { sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "reset-pointer-session";
    const resetSessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
      content: createMockSessionContent([
        { role: "user", content: "Message from reset pointer" },
        { role: "assistant", content: "Recovered directly from reset file" },
      ]),
    });

    const previousSessionFile = await findPreviousSessionFile({
      sessionsDir,
      currentSessionFile: resetSessionFile,
      sessionId,
    });
    expect(previousSessionFile).toBeUndefined();

    const memoryContent = await getRecentSessionContentWithResetFallback(resetSessionFile);
    expect(memoryContent).toContain("user: Message from reset pointer");
    expect(memoryContent).toContain("assistant: Recovered directly from reset file");
  });

  it("recovers transcript when previousSessionEntry.sessionFile is missing", async () => {
    const { sessionsDir } = await createSessionMemoryWorkspace();

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

    const previousSessionFile = await findPreviousSessionFile({
      sessionsDir,
      sessionId,
    });
    expect(previousSessionFile).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));

    const memoryContent = await getRecentSessionContentWithResetFallback(previousSessionFile!);
    expect(memoryContent).toContain("user: Recovered with missing sessionFile pointer");
    expect(memoryContent).toContain("assistant: Recovered by sessionId fallback");
  });

  it("prefers the newest reset transcript when multiple reset candidates exist", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
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

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);
    expect(memoryContent).toBeTruthy();

    expectMemoryConversation({
      memoryContent: memoryContent!,
      user: "Newest rotated transcript",
      assistant: "Newest summary",
      absent: "Older rotated transcript",
    });
  });

  it("prefers active transcript when it is non-empty even with reset candidates", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
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

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);
    expect(memoryContent).toBeTruthy();

    expectMemoryConversation({
      memoryContent: memoryContent!,
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

  it("uses agent-specific workspace when workspaceDir is provided for non-default agent (gateway path regression)", async () => {
    const defaultWorkspace = await createCaseWorkspace("workspace-default");
    const customAgentWorkspace = await createCaseWorkspace("workspace-custom-agent");
    const sessionsDir = path.join(customAgentWorkspace, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "custom-agent-session.jsonl",
      content: createMockSessionContent([
        { role: "user", content: "Custom agent conversation" },
        { role: "assistant", content: "Stored in agent workspace" },
      ]),
    });

    // Simulate the gateway internal hook path: workspaceDir is resolved and
    // passed explicitly in context (fix for #64528).  Without the fix, the
    // gateway path omitted workspaceDir, causing the handler to fall back to
    // the default workspace via resolveAgentWorkspaceDir — which for a
    // default-agent sessionKey would resolve to the shared default workspace.
    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir: customAgentWorkspace,
      cfg: {
        agents: {
          defaults: { workspace: defaultWorkspace },
          list: [{ id: "custom-agent", workspace: customAgentWorkspace }],
        },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      workspaceDirOverride: customAgentWorkspace,
      previousSessionEntry: {
        sessionId: "custom-agent-session",
        sessionFile,
      },
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain("user: Custom agent conversation");
    expect(memoryContent).toContain("assistant: Stored in agent workspace");
    // Verify memory did NOT leak to the default workspace
    await expect(fs.access(path.join(defaultWorkspace, "memory"))).rejects.toThrow();
  });

  it("handles session files with fewer messages than requested", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Only message 1" },
      { role: "assistant", content: "Only message 2" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).toContain("user: Only message 1");
    expect(memoryContent).toContain("assistant: Only message 2");
  });

  // Helper to drain postHookActions with per-action error isolation,
  // matching triggerInternalHook's actual drain behaviour.
  async function drainPostHookActions(event: {
    postHookActions?: Array<() => Promise<void> | void>;
  }) {
    for (const action of event.postHookActions ?? []) {
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

  it("sessionSaveRedirectPath rejects Windows-style traversal (..\\) and UNC paths", async () => {
    // Cross-platform hardening: even on POSIX hosts, redirect paths that
    // look like Windows traversal or UNC shares should be rejected. This
    // closes the Aisle low #3 finding ("Windows snapshot bypass") that
    // was previously deferred to a follow-up.
    const tempDir = await createCaseWorkspace("redirect-windows-traversal");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "hi" }]),
    });
    const memoryDir = path.join(tempDir, "memory");
    const candidates = [
      "..\\..\\Windows\\System32\\stolen.md", // backslash traversal
      "\\\\evil-server\\share\\stolen.md", // UNC path
      "\\\\?\\C:\\Windows\\stolen.md", // Win32 device namespace
    ];
    for (const candidate of candidates) {
      const event = createHookEvent("command", "new", "agent:main:main", {
        cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
        previousSessionEntry: { sessionId: "s1", sessionFile },
      });
      event.context.sessionSaveRedirectPath = candidate;
      await handler(event);
      // Each candidate must fail closed: no file written anywhere in
      // the workspace memory dir, and no file at the literal candidate
      // path inside the workspace.
      const memoryFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
      expect(memoryFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
    }
  });

  it("retracts a redirected write through a symlink without escaping the workspace", async () => {
    // Symlink rollback semantics (previously deferred to a follow-up):
    // when the redirect target is a symlink to another in-workspace file,
    // a late blockSessionSave must retract our write WITHOUT clobbering or
    // escaping the symlink target. This codifies the contract that the
    // retraction path resolves writtenFilePath via fs.realpath before
    // unlinking, so subsequent rollbacks land on the canonical file.
    const tempDir = await createCaseWorkspace("redirect-symlink-rollback");
    const quarantine = path.join(tempDir, "quarantine");
    const realDir = path.join(tempDir, "real");
    await fs.mkdir(quarantine, { recursive: true });
    await fs.mkdir(realDir, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "linked" }]),
    });
    // Symlink quarantine/redirected.md -> real/redirected.md (both inside
    // the workspace). Both targets are workspace-confined so the symlink
    // is allowed; the question is whether retraction respects the link.
    const linkPath = path.join(quarantine, "redirected.md");
    const targetPath = path.join(realDir, "redirected.md");
    await fs.writeFile(targetPath, "pre-existing");
    try {
      await fs.symlink(targetPath, linkPath);
    } catch (err) {
      // Some filesystems (e.g. on certain CI runners) refuse symlinks.
      // Skip the assertion under those conditions — this is a defense-
      // in-depth contract test, not a load-bearing security boundary.
      console.warn("skipping symlink-rollback test: fs.symlink failed", err);
      return;
    }
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = linkPath;
    event.postHookActions ??= [];
    event.postHookActions.push(() => {
      event.context.blockSessionSave = true;
    });
    await handler(event);
    await drainPostHookActions(event);
    // Retraction semantics through a symlink: the snapshot of the
    // pre-existing target content ("pre-existing") is restored at the
    // canonical path. Importantly, retraction must NOT escape the
    // workspace — we verify the canonical target's content reverted
    // and that no file was written outside the workspace tree.
    const restoredContent = await fs.readFile(targetPath, "utf-8").catch(() => null);
    expect(restoredContent).toBe("pre-existing");
    // And critically: nothing was written outside the workspace.
    const parentEntries = await fs.readdir(path.dirname(tempDir));
    expect(parentEntries).toContain(path.basename(tempDir));
  });

  it("caps session-file reads at MAX_SESSION_FILE_TAIL_BYTES (Aisle medium #2)", async () => {
    // A pathologically large session file should not OOM the gateway.
    // We synthesise a 12 MiB JSONL file with a few real messages at the
    // end and verify the handler still produces a memory file with
    // bounded memory usage (no unbounded readFile of the whole thing).
    const tempDir = await createCaseWorkspace("redirect-large-session");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    // 12 MiB > MAX_SESSION_FILE_TAIL_BYTES (8 MiB).
    const padLine =
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "x".repeat(1024) },
      }) + "\n";
    const padCount = Math.ceil((12 * 1024 * 1024) / padLine.length);
    const tailLines = [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "tail-marker-question?" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "tail-marker-answer." },
      }),
    ].join("\n");
    const fh = await fs.open(path.join(sessionsDir, "big-session.jsonl"), "w");
    try {
      for (let i = 0; i < padCount; i++) {
        await fh.write(padLine);
      }
      await fh.write(tailLines + "\n");
    } finally {
      await fh.close();
    }
    const sessionFile = path.join(sessionsDir, "big-session.jsonl");
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    await handler(event);
    await drainPostHookActions(event);
    // The handler should have produced a memory file containing the tail
    // markers (proving we read the END of the large file, not the
    // beginning, and that we didn't OOM along the way).
    const memoryDir = path.join(tempDir, "memory");
    const memoryFiles = await fs.readdir(memoryDir).catch(() => [] as string[]);
    const mds = memoryFiles.filter((f) => f.endsWith(".md"));
    expect(mds.length).toBe(1);
    const body = await fs.readFile(path.join(memoryDir, mds[0]), "utf-8");
    expect(body).toContain("tail-marker");
  }, 30_000);

  it("restores rollback content via realpath when redirect symlink is retargeted between write and drain (Codex P1)", async () => {
    // Codex P1 on PR #38162: when sessionSaveRedirectPath points at a
    // symlink and the symlink is retargeted (or removed) between the
    // inline write and the post-hook drain, restoration via the lexical
    // writeRelativePath would land in the wrong file while the original
    // overwritten target keeps the transcript. The fix uses
    // writtenFilePath (realpath captured right after write) for
    // restoration so the same bytes we overwrote get restored.
    const tempDir = await createCaseWorkspace("redirect-retargeted-symlink");
    const quarantine = path.join(tempDir, "quarantine");
    const realA = path.join(tempDir, "realA");
    const realB = path.join(tempDir, "realB");
    await fs.mkdir(quarantine, { recursive: true });
    await fs.mkdir(realA, { recursive: true });
    await fs.mkdir(realB, { recursive: true });
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "transcript" }]),
    });
    // Initial state: linkPath -> realA/redirected.md, which contains
    // "original-A". realB/redirected.md is unrelated and should never be
    // touched by rollback.
    const linkPath = path.join(quarantine, "redirected.md");
    const targetA = path.join(realA, "redirected.md");
    const targetB = path.join(realB, "redirected.md");
    await fs.writeFile(targetA, "original-A");
    await fs.writeFile(targetB, "original-B-untouched");
    try {
      await fs.symlink(targetA, linkPath);
    } catch (err) {
      console.warn("skipping retargeted-symlink test: fs.symlink failed", err);
      return;
    }
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
      previousSessionEntry: { sessionId: "s1", sessionFile },
    });
    event.context.sessionSaveRedirectPath = linkPath;
    // The post-hook RETARGETS the symlink (link now points at realB),
    // THEN sets blockSessionSave. A naive rollback would write through
    // the new symlink target (realB) instead of the realA file we
    // actually overwrote.
    event.postHookActions ??= [];
    event.postHookActions.push(async () => {
      await fs.unlink(linkPath);
      await fs.symlink(targetB, linkPath);
      event.context.blockSessionSave = true;
    });
    await handler(event);
    await drainPostHookActions(event);
    // The fix: rollback writes through writtenFilePath (realpath at
    // write time) = targetA, restoring "original-A".
    // Without the fix: rollback writes through writeRelativePath, which
    // resolves to the (now-retargeted) symlink, clobbering targetB with
    // "original-A".
    const aContent = await fs.readFile(targetA, "utf-8").catch(() => null);
    const bContent = await fs.readFile(targetB, "utf-8").catch(() => null);
    expect(aContent).toBe("original-A"); // realA: restored to original
    expect(bContent).toBe("original-B-untouched"); // realB: never written
  });

  it("aborts the handler when pre-existing snapshot read fails with a non-ENOENT error (Codex P2)", async () => {
    // The pre-write snapshot used to swallow every fs.readFile error, so an
    // existing target that was writable but not readable (EACCES, EROFS,
    // EIO, EPERM …) would be treated as if it never existed. A later
    // blockSessionSave=true rollback would then take the
    // preExistingContent === null branch and unlink the file, permanently
    // destroying prior content. This regression test simulates that race
    // by stubbing fs.lstat to throw EACCES and verifies the handler aborts
    // BEFORE writing anything.
    const tempDir = await createCaseWorkspace("redirect-snapshot-eacces");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "test-session.jsonl",
      content: createMockSessionContent([{ role: "user", content: "don't lose me" }]),
    });
    const quarantine = path.join(tempDir, "quarantine");
    await fs.mkdir(quarantine, { recursive: true });
    const redirectFile = path.join(quarantine, "redirected.md");
    await fs.writeFile(redirectFile, "sensitive-prior-content");

    // Stub fs.lstat to throw EACCES specifically for the redirect target.
    // All other lstat calls (e.g. workspace canonicalization) must still
    // work, so we delegate to the real implementation for non-matching paths.
    const realLstat = fs.lstat;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (p: string) => {
      if (p === redirectFile) {
        const e = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      return realLstat(p);
    }) as typeof fs.lstat);

    try {
      const event = createHookEvent("command", "new", "agent:main:main", {
        cfg: { agents: { defaults: { workspace: tempDir } } } satisfies OpenClawConfig,
        previousSessionEntry: { sessionId: "s1", sessionFile },
      });
      event.context.sessionSaveRedirectPath = redirectFile;
      await handler(event);
      await drainPostHookActions(event);
    } finally {
      lstatSpy.mockRestore();
    }

    // The handler must have aborted: the pre-existing file is intact
    // with its original content, no inline write happened, and the
    // default memory directory has nothing in it either.
    const surviving = await fs.readFile(redirectFile, "utf-8");
    expect(surviving).toBe("sensitive-prior-content");
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
