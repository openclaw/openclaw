// Transcript archive event tests ensure file archive/delete operations emit
// path-only transcript update notifications for UI and index listeners.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscriptsDetailed,
} from "./session-transcript-files.fs.js";

const subscriptions: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (subscriptions.length > 0) {
    subscriptions.pop()?.();
  }
});

describe("archiveFileOnDisk transcript updates", () => {
  it("emits a session transcript update for the archived path on reset", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-reset-"));
    try {
      const sessionFile = path.join(tmpDir, "live.jsonl");
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveFileOnDisk(sessionFile, "reset");

      expect(fs.existsSync(archived)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(archived).toContain(".jsonl.reset.");
      expect(updates).toHaveLength(1);
      expect(updates[0].sessionFile).toBe(archived);
      // Archive does not carry a messageId/message payload — this is a
      // pure-path mutation notification, matching how compaction-only
      // emits (sessionFile + sessionKey-only) behave.
      expect(updates[0].message).toBeUndefined();
      expect(updates[0].messageId).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("also emits for deleted and bak archive reasons", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-mixed-"));
    try {
      const deletedSource = path.join(tmpDir, "deleted.jsonl");
      fs.writeFileSync(deletedSource, "{}\n");
      const deletedArchived = archiveFileOnDisk(deletedSource, "deleted");

      const bakSource = path.join(tmpDir, "bak.jsonl");
      fs.writeFileSync(bakSource, "{}\n");
      const bakArchived = archiveFileOnDisk(bakSource, "bak");

      expect(deletedArchived).toContain(".jsonl.deleted.");
      expect(bakArchived).toContain(".jsonl.bak.");
      expect(updates.map((update) => update.sessionFile)).toEqual([deletedArchived, bakArchived]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("archiveSessionTranscriptsDetailed failure surface", () => {
  it("invokes onArchiveError when fs.renameSync fails and returns only successful entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-failure-"));
    try {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const renameError = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw renameError;
      });

      const errors: Array<{ err: unknown; sourcePath: string }> = [];
      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
        onArchiveError: (err, sourcePath) => {
          errors.push({ err, sourcePath });
        },
      });

      renameSpy.mockRestore();

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].err).toBe(renameError);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives normally when no onArchiveError is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-success-"));
    try {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      expect(archived.length).toBe(1);
      expect(archived[0].archivedPath).toContain(".jsonl.reset.");
      expect(fs.existsSync(archived[0].archivedPath)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves the sibling trajectory and pointer on reset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-reset-"));
    try {
      const sessionId = "44444444-4444-4444-8444-444444444444";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
      fs.writeFileSync(trajectoryFile, '{"traceSchema":"openclaw-trajectory"}\n');
      fs.writeFileSync(pointerFile, `{"runtimeFile":${JSON.stringify(trajectoryFile)}}\n`);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      expect(archived).toHaveLength(1);
      // The live trajectory artifacts are renamed, not deleted, so post-reset
      // forensics can still read the assistant's tool calls/results (#90707).
      expect(fs.existsSync(trajectoryFile)).toBe(false);
      expect(fs.existsSync(pointerFile)).toBe(false);
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining.some((name) => name.includes(".trajectory.jsonl.reset."))).toBe(true);
      expect(remaining.some((name) => name.includes(".trajectory-path.json.reset."))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not archive trajectory siblings for a deleted session", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-trajectory-deleted-"));
    try {
      const sessionId = "55555555-5555-4555-8555-555555555555";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      const trajectoryFile = path.join(tmpDir, `${sessionId}.trajectory.jsonl`);
      const pointerFile = path.join(tmpDir, `${sessionId}.trajectory-path.json`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
      fs.writeFileSync(trajectoryFile, '{"traceSchema":"openclaw-trajectory"}\n');
      fs.writeFileSync(pointerFile, `{"runtimeFile":${JSON.stringify(trajectoryFile)}}\n`);

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "deleted",
      });

      expect(archived).toHaveLength(1);
      // A deleted/pruned session still owns the trajectory removal path, so the
      // archive step must leave the live siblings untouched.
      expect(fs.existsSync(trajectoryFile)).toBe(true);
      expect(fs.existsSync(pointerFile)).toBe(true);
      const remaining = fs.readdirSync(tmpDir);
      expect(remaining.some((name) => name.includes(".trajectory.jsonl.reset."))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces real chmod archive failures through onArchiveError", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-real-eacces-")),
    );
    try {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
      fs.chmodSync(tmpDir, 0o555);

      const errors: Array<{ code?: string; sourcePath: string }> = [];
      let archived: ReturnType<typeof archiveSessionTranscriptsDetailed> = [];
      try {
        archived = archiveSessionTranscriptsDetailed({
          sessionId,
          storePath: path.join(tmpDir, "store.json"),
          sessionFile,
          agentId: "main",
          reason: "reset",
          onArchiveError: (err, sourcePath) => {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            errors.push({ code, sourcePath });
          },
        });
      } finally {
        fs.chmodSync(tmpDir, 0o755);
      }

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].sourcePath).toBe(sessionFile);
      expect(errors[0].code).toMatch(/^(EACCES|EPERM)$/);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      try {
        fs.chmodSync(tmpDir, 0o755);
      } catch {
        // Already restored.
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
