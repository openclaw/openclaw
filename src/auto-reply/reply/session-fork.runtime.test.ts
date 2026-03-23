import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const emitSessionTranscriptUpdateMock = vi.fn();
vi.mock("../../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: (value: unknown) => emitSessionTranscriptUpdateMock(value),
}));

const createBranchedSessionMock = vi.fn();
const getSessionFileMock = vi.fn();
const getSessionIdMock = vi.fn();
const getLeafIdMock = vi.fn();
const getSessionDirMock = vi.fn();
const getCwdMock = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CURRENT_SESSION_VERSION: 3,
  SessionManager: {
    open: () => ({
      getLeafId: getLeafIdMock,
      createBranchedSession: createBranchedSessionMock,
      getSessionFile: getSessionFileMock,
      getSessionId: getSessionIdMock,
      getSessionDir: getSessionDirMock,
      getCwd: getCwdMock,
    }),
  },
}));

import { forkSessionFromParentRuntime } from "./session-fork.runtime.js";

describe("forkSessionFromParentRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    emitSessionTranscriptUpdateMock.mockReset();
    createBranchedSessionMock.mockReset();
    getSessionFileMock.mockReset();
    getSessionIdMock.mockReset();
    getLeafIdMock.mockReset();
    getSessionDirMock.mockReset();
    getCwdMock.mockReset();
  });

  it("emits transcript update when branch session is created", () => {
    getLeafIdMock.mockReturnValue("leaf-1");
    createBranchedSessionMock.mockReturnValue("/tmp/child.jsonl");
    getSessionFileMock.mockReturnValue("/tmp/fallback.jsonl");
    getSessionIdMock.mockReturnValue("child-session");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const result = forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-session",
        updatedAt: Date.now(),
        sessionFile: "/tmp/parent.jsonl",
      },
      agentId: "main",
      sessionsDir: "/tmp",
    });

    expect(result).toEqual({ sessionId: "child-session", sessionFile: "/tmp/child.jsonl" });
    expect(emitSessionTranscriptUpdateMock).toHaveBeenCalledWith("/tmp/child.jsonl");
    existsSpy.mockRestore();
  });

  it("emits transcript update for header-only fallback file creation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fork-runtime-"));
    const parentSessionFile = path.join(root, "parent.jsonl");
    fs.writeFileSync(parentSessionFile, "{}\n", "utf-8");
    const sessionsDir = path.join(root, "sessions");
    fs.mkdirSync(sessionsDir);

    getLeafIdMock.mockReturnValue(null);
    getSessionDirMock.mockReturnValue(sessionsDir);
    getCwdMock.mockReturnValue(root);

    const result = forkSessionFromParentRuntime({
      parentEntry: {
        sessionId: "parent-session",
        updatedAt: Date.now(),
        sessionFile: parentSessionFile,
      },
      agentId: "main",
      sessionsDir: root,
    });

    expect(result?.sessionFile).toMatch(/\.jsonl$/);
    expect(result?.sessionId).toBeTruthy();
    expect(emitSessionTranscriptUpdateMock).toHaveBeenCalledTimes(1);
    const emittedPath = emitSessionTranscriptUpdateMock.mock.calls[0]?.[0];
    expect(typeof emittedPath).toBe("string");
    expect(fs.existsSync(String(emittedPath))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
