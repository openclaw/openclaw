import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_ARCHIVE_SHUTDOWN_REASON } from "../gateway/shutdown-state.js";
import { archiveAndTerminateCurrentSession, isTranscriptEmptyShell } from "./archive-service.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-service-"));
}

describe("archiveAndTerminateCurrentSession", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves transcript into sessions/archive and terminates with user-archive reason", async () => {
    const tmpDir = createTmpDir();
    tmpDirs.push(tmpDir);
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "session-1";
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "session", id: sessionId }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
      ].join("\n"),
      "utf-8",
    );
    const terminate = vi.fn();
    const flush = vi.fn(async () => undefined);

    const result = await archiveAndTerminateCurrentSession({
      sessionKey: "agent:main:main",
      sessionId,
      storePath,
      flush,
      terminate,
      nowMs: Date.UTC(2026, 1, 28, 12, 0, 0),
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(transcriptPath)).toBe(false);
    expect(fs.existsSync(result.archivedPath)).toBe(true);
    expect(result.archiveDir).toContain(path.join(tmpDir, "archive"));
    expect(path.dirname(result.archivedPath)).toBe(result.archiveDir);
    expect(path.relative(result.archiveDir, result.archivedPath)).not.toContain(path.sep);
    expect(terminate).toHaveBeenCalledWith(USER_ARCHIVE_SHUTDOWN_REASON);
  });

  it("does not terminate when archive fails", async () => {
    const tmpDir = createTmpDir();
    tmpDirs.push(tmpDir);
    const terminate = vi.fn();
    const archiveRootFile = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(archiveRootFile, "x", "utf-8");

    await expect(
      archiveAndTerminateCurrentSession({
        sessionKey: "agent:main:archive-failure",
        sessionId: "archive-failure",
        storePath: path.join(tmpDir, "sessions.json"),
        archiveRoot: archiveRootFile,
        terminate,
      }),
    ).rejects.toThrow();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("creates a shell transcript when missing and still archives", async () => {
    const tmpDir = createTmpDir();
    tmpDirs.push(tmpDir);
    const terminate = vi.fn();

    const result = await archiveAndTerminateCurrentSession({
      sessionKey: "agent:main:missing-shell",
      sessionId: "missing-shell",
      storePath: path.join(tmpDir, "sessions.json"),
      terminate,
      nowMs: Date.UTC(2026, 1, 28, 12, 0, 0),
    });

    expect(fs.existsSync(result.archivedPath)).toBe(true);
    expect(path.dirname(result.archivedPath)).toBe(path.join(tmpDir, "archive"));
    expect(terminate).toHaveBeenCalledWith(USER_ARCHIVE_SHUTDOWN_REASON);
  });
});

describe("isTranscriptEmptyShell", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true for header-only transcripts", async () => {
    const tmpDir = createTmpDir();
    tmpDirs.push(tmpDir);
    const filePath = path.join(tmpDir, "header-only.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({ type: "session", id: "a" }), "utf-8");
    await expect(isTranscriptEmptyShell(filePath)).resolves.toBe(true);
  });

  it("returns false when transcript contains user prompts", async () => {
    const tmpDir = createTmpDir();
    tmpDirs.push(tmpDir);
    const filePath = path.join(tmpDir, "non-empty.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session", id: "a" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      ].join("\n"),
      "utf-8",
    );
    await expect(isTranscriptEmptyShell(filePath)).resolves.toBe(false);
  });
});
