import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
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
}): Promise<{
  files: string[];
  archiveFiles: string[];
  memoryContent: string;
  recentLatestContent: string;
  snapshotFiles: string[];
}> {
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
  const archiveFiles = files.filter((name) => name.endsWith(".md"));
  const memoryContent =
    archiveFiles.length > 0
      ? await fs.readFile(path.join(memoryDir, archiveFiles[0]), "utf-8")
      : "";
  const latestPath = path.join(memoryDir, "recent", "latest.md");
  let recentLatestContent = "";
  try {
    recentLatestContent = await fs.readFile(latestPath, "utf-8");
  } catch {
    recentLatestContent = "";
  }
  const snapshotsDir = path.join(memoryDir, "recent", "snapshots");
  let snapshotFiles: string[] = [];
  try {
    snapshotFiles = await fs.readdir(snapshotsDir);
  } catch {
    snapshotFiles = [];
  }
  return { files, archiveFiles, memoryContent, recentLatestContent, snapshotFiles };
}

async function runNewWithPreviousSession(params: {
  sessionContent: string;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
}): Promise<{
  tempDir: string;
  files: string[];
  memoryContent: string;
  recentLatestContent: string;
  snapshotFiles: string[];
}> {
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

  const { archiveFiles, memoryContent, recentLatestContent, snapshotFiles } =
    await runNewWithPreviousSessionEntry({
      tempDir,
      cfg,
      action: params.action,
      previousSessionEntry: {
        sessionId: "test-123",
        sessionFile,
      },
    });
  return {
    tempDir,
    files: archiveFiles,
    memoryContent,
    recentLatestContent,
    snapshotFiles,
  };
}

async function runCompactionCheckpoint(params: {
  sessionContent: string;
  sessionKey?: string;
}): Promise<{
  tempDir: string;
  archiveFiles: string[];
  recentLatestContent: string;
  snapshotFiles: string[];
}> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "active-session.jsonl",
    content: params.sessionContent,
  });

  const event = createHookEvent(
    "session",
    "compact:before",
    params.sessionKey ?? "agent:main:main",
    {
      workspaceDir: tempDir,
      sessionId: "compact-123",
      sessionFile,
    },
  );

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const archiveFiles = files.filter((name) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(name));
  const recentLatestContent = await fs.readFile(
    path.join(memoryDir, "recent", "latest.md"),
    "utf-8",
  );
  const snapshotFiles = await fs.readdir(path.join(memoryDir, "recent", "snapshots"));

  return { tempDir, archiveFiles, recentLatestContent, snapshotFiles };
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

  it("writes recent continuity latest and snapshot files", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "We need to keep continuity stable" },
      { role: "assistant", content: "I will add a recent snapshot layer" },
      { role: "user", content: "Then wire it into compaction" },
    ]);
    const { recentLatestContent, snapshotFiles } = await runNewWithPreviousSession({
      sessionContent,
    });

    expect(snapshotFiles.length).toBe(1);
    expect(recentLatestContent).toContain("type: recent_snapshot");
    expect(recentLatestContent).toContain("## Current Task");
    expect(recentLatestContent).toContain("## Conversation Summary");
    expect(recentLatestContent).toContain("We need to keep continuity stable");
  });

  it("writes only recent continuity on pre-compaction checkpoints", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "We are about to hit compaction" },
      { role: "assistant", content: "Capture the current task before the window shrinks" },
    ]);

    const { archiveFiles, recentLatestContent, snapshotFiles } = await runCompactionCheckpoint({
      sessionContent,
    });

    expect(archiveFiles).toEqual([]);
    expect(snapshotFiles.length).toBe(1);
    expect(recentLatestContent).toContain("source: session-memory:compaction");
    expect(recentLatestContent).toContain("We are about to hit compaction");
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

    const { archiveFiles, memoryContent } = await runNewWithPreviousSessionEntry({
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

    expect(archiveFiles.length).toBe(1);
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

    const previousSessionFile = await findPreviousSessionFile({
      sessionsDir,
      currentSessionFile: resetSessionFile,
      sessionId,
    });
    expect(previousSessionFile).toBeUndefined();
    const { archiveFiles, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: {
        agents: { defaults: { workspace: tempDir } },
      } satisfies OpenClawConfig,
      previousSessionEntry: {
        sessionId,
        sessionFile: resetSessionFile,
      },
    });
    expect(archiveFiles.length).toBe(1);

    const transcriptContent = await getRecentSessionContentWithResetFallback(resetSessionFile);
    expect(transcriptContent).toContain("user: Message from reset pointer");
    expect(transcriptContent).toContain("assistant: Recovered directly from reset file");
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

    const previousSessionFile = await findPreviousSessionFile({
      sessionsDir,
      sessionId,
    });
    expect(previousSessionFile).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));
    const { archiveFiles, memoryContent } = await runNewWithPreviousSessionEntry({
      tempDir,
      cfg: {
        agents: { defaults: { workspace: tempDir } },
      } satisfies OpenClawConfig,
      previousSessionEntry: {
        sessionId,
      },
    });
    expect(archiveFiles.length).toBe(1);

    const transcriptContent = await getRecentSessionContentWithResetFallback(previousSessionFile!);
    expect(transcriptContent).toContain("user: Recovered with missing sessionFile pointer");
    expect(transcriptContent).toContain("assistant: Recovered by sessionId fallback");
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

  it("handles session files with fewer messages than requested", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "Only message 1" },
      { role: "assistant", content: "Only message 2" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).toContain("user: Only message 1");
    expect(memoryContent).toContain("assistant: Only message 2");
  });
});
