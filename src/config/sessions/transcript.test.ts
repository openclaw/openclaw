import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "./types.js";

const state = vi.hoisted(() => ({
  sessionFile: "",
  store: {} as Record<string, SessionEntry>,
  appendMessage: vi.fn(() => "message-1"),
}));

vi.mock("../io.js", () => ({
  loadConfig: () => ({
    agents: {
      list: [{ id: "sunke", default: true }],
    },
  }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "sunke",
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) =>
    `/Users/admin/.openclaw/workspace-${agentId}`,
}));

vi.mock("../../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: vi.fn(),
}));

vi.mock("./delivery-info.js", () => ({
  parseSessionThreadInfo: () => ({ baseSessionKey: undefined, threadId: undefined }),
}));

vi.mock("./paths.js", () => ({
  resolveDefaultSessionStorePath: () => "/tmp/session-store.json",
  resolveSessionFilePath: () => state.sessionFile,
  resolveSessionFilePathOptions: () => ({
    agentId: "sunke",
    sessionsDir: path.dirname(state.sessionFile),
  }),
  resolveSessionTranscriptPath: () => state.sessionFile,
}));

vi.mock("./session-file.js", () => ({
  resolveAndPersistSessionFile: async () => ({
    sessionFile: state.sessionFile,
    sessionEntry: state.store["agent:main:test:user-1"],
  }),
}));

vi.mock("./store.js", () => ({
  loadSessionStore: () => state.store,
  normalizeStoreSessionKey: (value: string) => value,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 2,
  SessionManager: {
    open: () => ({
      appendMessage: state.appendMessage,
    }),
  },
}));

let appendAssistantMessageToSessionTranscript: typeof import("./transcript.js").appendAssistantMessageToSessionTranscript;
const originalCwd = process.cwd();

beforeEach(async () => {
  vi.resetModules();
  state.appendMessage = vi.fn(() => "message-1");
  state.store = {
    "agent:main:test:user-1": {
      sessionId: "session-1",
      updatedAt: Date.now(),
    } as SessionEntry,
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-"));
  const wrongWorkspace = path.join(tmpRoot, "wrong-workspace");
  fs.mkdirSync(wrongWorkspace, { recursive: true });
  process.chdir(wrongWorkspace);

  state.sessionFile = path.join(tmpRoot, "sessions", "session-1.jsonl");
  ({ appendAssistantMessageToSessionTranscript } = await import("./transcript.js"));
});

afterEach(() => {
  process.chdir(originalCwd);
});

describe("appendAssistantMessageToSessionTranscript", () => {
  it("writes the session header cwd from the target agent workspace instead of process.cwd()", async () => {
    const result = await appendAssistantMessageToSessionTranscript({
      agentId: "sunke",
      sessionKey: "agent:main:test:user-1",
      text: "hello",
    });

    expect(result).toEqual({
      ok: true,
      sessionFile: state.sessionFile,
      messageId: "message-1",
    });

    const [headerLine] = fs.readFileSync(state.sessionFile, "utf-8").split(/\r?\n/);
    const header = JSON.parse(headerLine) as { cwd?: string };

    expect(header.cwd).toBe("/Users/admin/.openclaw/workspace-sunke");
    expect(header.cwd).not.toBe(process.cwd());
  });
});
